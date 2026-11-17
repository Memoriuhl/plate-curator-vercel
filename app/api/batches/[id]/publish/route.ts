import type { PublishCommand, PublishDeps, PublishRequester } from '../../../../../lib/publish/types'
import { sameRequester } from '../../../../../lib/publish/authority'
import { isPublishStop, PUBLISH_STOPS } from '../../../../../lib/publish/stop'
import { randomUUID } from 'node:crypto'
import { publishControlStop } from '../../../../../lib/publish/control'
import { getRun, resumeHook, start } from 'workflow/api'
import { HookConflictError } from 'workflow/errors'
import type { ApprovalResult } from '../../../../../lib/review/run-status'
import { currentActiveOwner, requesterAuthority, publishAllowed, publishDeps, reviewDeps } from '../../../../../lib/server/context'
import { publishBaselineStatus } from '../../../../../lib/publish/baseline-status'
import { badRequest, json, readJson } from '../../../../../lib/server/respond'

async function dispatchRetry(publishing: PublishDeps, accepted: { command: PublishCommand; runId?: string }, ownerUid: string, now: string) {
  let runId = accepted.runId
  if (!runId) {
    const { publishRun } = await import('../../../../../workflows/approval')
    try {
      runId = (await start(publishRun, [accepted.command.batchId, accepted.command.revision, { ownerUid, ...accepted.command }], {
        experimental_hook: { token: `publish-command:${accepted.command.commandId}`, experimental_minRetention: '36500d' },
      })).runId
    } catch (error) {
      if (!HookConflictError.is(error)) throw error
      runId = error.conflictingRunId
    }
  }
  if (!runId || !await publishing.records.bindRun(accepted.command, runId, now)) return json({ error: 'unavailable' }, 503)
  return json({ status: 'publishing', runId }, 202)
}

export async function POST(request: Request, ctx: RouteContext<'/api/batches/[id]/publish'>) {
  const auth = await currentActiveOwner(request)
  if (!auth.ok) return auth.response
  if (!publishAllowed()) return json({ error: 'publish_disabled_here' }, 403)

  const body = await readJson(request)
  if (typeof body?.revision !== 'number') return badRequest()
  if (body.commandId !== undefined && (typeof body.commandId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(body.commandId))) return badRequest()

  const { id } = await ctx.params
  const deps = reviewDeps()
  const publishing = publishDeps()
  const requestedBy = requesterAuthority(auth.actor)
  if (body.commandId) {
    try {
      const accepted = await publishing.records.command(body.commandId)
      if (accepted) {
        if (accepted.command.batchId !== id || accepted.command.revision !== body.revision || !sameRequester(accepted.command.requestedBy, requestedBy)) return json({ error: 'superseded' }, 409)
        return await dispatchRetry(publishing, accepted, auth.actor.uid, deps.now())
      }
    } catch { return json({ error: 'unavailable' }, 503) }
  }
  const batch = await deps.store.getBatch(id)
  if (!batch) return json({ error: 'not_found' }, 404)
  if (batch.state !== 'approved' || batch.revision !== body.revision) return json({ error: 'superseded_revision' }, 409)

  let control
  try { control = await publishing.control.read() } catch { return json({ error: 'unavailable' }, 503) }
  if (!control) return json({ error: PUBLISH_STOPS.notEnabled }, 409)
  const stop = publishControlStop(control)
  if (stop) return json({ error: stop }, 409)
  const baseline = await publishBaselineStatus(publishing, batch)
  if (baseline.error) return json(baseline, 409)
  try {
    const command: PublishRequester = { ownerUid: auth.actor.uid, requestedBy, generation: control.generation, commandId: body.commandId ?? randomUUID() }
    const receipt = await publishing.records.get(`${id}@${body.revision}`)
    let stopped = receipt && !receipt.committedAt ? !!await publishing.records.stopped(receipt) : false
    if (!stopped && batch.approvalRun) {
      const run = getRun<ApprovalResult>(batch.approvalRun.runId)
      if (await run.status === 'completed') {
        const result = await run.returnValue
        stopped = result.outcome === 'publish_failed' && isPublishStop(result.error)
      }
    }
    if (stopped) {
      const accepted = await publishing.records.accept({ batchId: id, revision: body.revision, ...command }, deps.now())
      if (typeof accepted === 'string') return json({ error: accepted }, 409)
      return await dispatchRetry(publishing, accepted, auth.actor.uid, deps.now())
    }
    try { await resumeHook(`publish:${id}:${body.revision}`, command) } catch { return json({ error: 'not_waiting' }, 409) }
  } catch {
    return json({ error: 'unavailable' }, 503)
  }
  await deps.store.requestPublish(id, body.revision, deps.now(), requestedBy)
  return json({ status: 'publishing' }, 202)
}

export async function GET(request: Request, ctx: RouteContext<'/api/batches/[id]/publish'>) {
  const auth = await currentActiveOwner(request)
  if (!auth.ok) return auth.response
  const { id } = await ctx.params
  const batch = await reviewDeps().store.getBatch(id)
  if (!batch) return json({ error: 'not_found' }, 404)
  try {
    const publishing = publishDeps()
    const stop = publishControlStop(await publishing.control.read())
    if (stop) return json({ error: stop })
    const baseline = await publishBaselineStatus(publishing, batch)
    const receipt = await publishing.records.get(`${id}@${batch.revision}`)
    const reason = receipt && !receipt.committedAt ? await publishing.records.stopped(receipt) : null
    return json({ ...baseline, ...(reason ? { stopped: { reason, ...(receipt?.requestedBy ? { requestedBy: receipt.requestedBy } : {}) } } : {}) })
  } catch { return json({ error: 'unavailable' }, 503) }
}
