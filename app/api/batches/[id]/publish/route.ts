import type { PublishCommand, PublishDeps } from '../../../../../lib/publish/types'
import { validCommandId } from '../../../../../lib/publish/types'
import { sameRequester } from '../../../../../lib/publish/authority'
import { PUBLISH_ERRORS } from '../../../../../lib/publish/stop'
import { publishStartToken, receiptId } from '../../../../../lib/publish/command'
import { randomUUID } from 'node:crypto'
import { publishControlStop } from '../../../../../lib/publish/control'
import { getHookByToken, resumeHook, start } from 'workflow/api'
import { HookConflictError, HookNotFoundError } from 'workflow/errors'
import { currentActiveOwner, requesterAuthority, publishAllowed, publishDeps, reviewDeps } from '../../../../../lib/server/context'
import { publishBaselineStatus } from '../../../../../lib/publish/baseline-status'
import { badRequest, json, readJson } from '../../../../../lib/server/respond'

async function dispatchRetry(publishing: PublishDeps, accepted: { command: PublishCommand; runId?: string }, ownerUid: string, now: string) {
  let runId = accepted.runId
  const token = publishStartToken(accepted.command.commandId!)
  if (!runId) {
    try { runId = (await getHookByToken(token)).runId } catch (error) { if (!HookNotFoundError.is(error)) throw error }
  }
  if (!runId) {
    const checked = await publishing.records.accept(accepted.command, now)
    if (!checked.ok) return json({ error: checked.error }, 409)
    runId = checked.runId
    if (!runId) {
      const { publishRun } = await import('../../../../../workflows/approval')
      try {
        runId = (await start(publishRun, [accepted.command.batchId, accepted.command.revision, { ownerUid, ...accepted.command }], {
          experimental_hook: { token, experimental_minRetention: '36500d' },
        })).runId
      } catch (error) {
        if (!HookConflictError.is(error)) throw error
        runId = error.conflictingRunId
      }
    }
  }
  if (!runId) return json({ error: PUBLISH_ERRORS.unavailable }, 503)
  if (!await publishing.records.bindRun(accepted.command, runId, now)) return json({ error: PUBLISH_ERRORS.superseded }, 409)
  return json({ status: 'publishing', runId }, 202)
}

export async function POST(request: Request, ctx: RouteContext<'/api/batches/[id]/publish'>) {
  const auth = await currentActiveOwner(request)
  if (!auth.ok) return auth.response
  if (!publishAllowed()) return json({ error: 'publish_disabled_here' }, 403)
  const body = await readJson(request)
  if (typeof body?.revision !== 'number' || !Number.isSafeInteger(body.revision) || body.revision < 0) return badRequest()
  if (body.commandId !== undefined && !validCommandId(body.commandId)) return badRequest()
  const { id } = await ctx.params
  const deps = reviewDeps()
  const publishing = publishDeps()
  const requestedBy = requesterAuthority(auth.actor)
  try {
    if (body.commandId) {
      const accepted = await publishing.records.command(body.commandId)
      if (accepted) {
        if (accepted.command.batchId !== id || accepted.command.revision !== body.revision || !sameRequester(accepted.command.requestedBy, requestedBy)) return json({ error: PUBLISH_ERRORS.superseded }, 409)
        return await dispatchRetry(publishing, accepted, auth.actor.uid, deps.now())
      }
    }
    const batch = await deps.store.getBatch(id)
    if (!batch) return json({ error: 'not_found' }, 404)
    if (batch.state !== 'approved' || batch.revision !== body.revision) return json({ error: 'superseded_revision' }, 409)
    const control = await publishing.control.read()
    const stop = publishControlStop(control)
    if (stop) return json({ error: stop }, 409)
    const baseline = await publishBaselineStatus(publishing, batch)
    if (baseline.error) return json(baseline, 409)
    const command: PublishCommand = { batchId: id, revision: body.revision, requestedBy, generation: control!.generation, commandId: body.commandId ?? randomUUID() }
    const eligibility = await publishing.records.eligibility(command, deps.now())
    if (eligibility.canRetry) {
      const accepted = await publishing.records.accept(command, deps.now())
      if (!accepted.ok) return json({ error: accepted.error }, 409)
      return await dispatchRetry(publishing, accepted, auth.actor.uid, deps.now())
    }
    if (eligibility.reason !== PUBLISH_ERRORS.notWaiting) return json({ error: eligibility.reason, reviewedVersion: eligibility.reviewedVersion, liveVersion: eligibility.liveVersion }, 409)
    const { batchId, revision, ...authority } = command
    try { await resumeHook(`publish:${batchId}:${revision}`, { ownerUid: auth.actor.uid, ...authority }) } catch { return json({ error: PUBLISH_ERRORS.notWaiting }, 409) }
    await deps.store.requestPublish(id, body.revision, deps.now(), requestedBy)
    return json({ status: 'publishing' }, 202)
  } catch { return json({ error: PUBLISH_ERRORS.unavailable }, 503) }
}

export async function GET(request: Request, ctx: RouteContext<'/api/batches/[id]/publish'>) {
  const auth = await currentActiveOwner(request)
  if (!auth.ok) return auth.response
  const { id } = await ctx.params
  const deps = reviewDeps()
  const batch = await deps.store.getBatch(id)
  if (!batch) return json({ error: 'not_found' }, 404)
  try {
    const publishing = publishDeps()
    const control = await publishing.control.read()
    const command = { batchId: id, revision: batch.revision, commandId: randomUUID(), requestedBy: requesterAuthority(auth.actor), generation: control?.generation }
    const eligibility = await publishing.records.eligibility(command, deps.now())
    const receipt = await publishing.records.get(receiptId(id, batch.revision))
    const reason = receipt && !receipt.committedAt ? await publishing.records.stopped(receipt) : null
    const stop = publishControlStop(control)
    const baseline = stop ? { error: stop } : await publishBaselineStatus(publishing, batch)
    return json({ ...baseline, canRetry: publishAllowed() && eligibility.canRetry, retryReason: eligibility.reason, ...(reason ? { stopped: { reason, ...(receipt?.requestedBy ? { requestedBy: receipt.requestedBy } : {}) } } : {}) })
  } catch { return json({ error: PUBLISH_ERRORS.unavailable }, 503) }
}
