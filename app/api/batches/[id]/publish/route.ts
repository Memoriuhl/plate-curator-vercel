import type {
  PublishCommand,
  PublishDeps,
} from '../../../../../lib/publish/types'
import { validCommandId } from '../../../../../lib/publish/types'
import { sameRequester } from '../../../../../lib/publish/authority'
import { PIPELINE_BUSY, PUBLISH_ERRORS } from '../../../../../lib/publish/stop'
import {
  draftCanBeConfirmed,
  publishStartToken,
  receiptId,
} from '../../../../../lib/publish/command'
import { randomUUID } from 'node:crypto'
import {
  publishCommandKey,
  publishControlStop,
} from '../../../../../lib/publish/control'
import { getHookByToken, resumeHook, start } from 'workflow/api'
import { HookConflictError, HookNotFoundError } from 'workflow/errors'
import {
  currentActiveOwner,
  requesterAuthority,
  publishAllowed,
  publishDeps,
  reviewDeps,
} from '../../../../../lib/server/context'
import { reviewApprovalProblems } from '../../../../../lib/review/batch'
import { publishBaselineStatus } from '../../../../../lib/publish/baseline-status'
import { badRequest, json, readJson } from '../../../../../lib/server/respond'

/**
 * Find or start the workflow for an accepted retry and attach its run ID to the same
 * command.
 */
async function dispatchRetry(
  publishing: PublishDeps,
  accepted: { command: PublishCommand; runId?: string },
  ownerUid: string,
  now: string
) {
  let runId = accepted.runId
  const token = publishStartToken(accepted.command.commandId!)
  if (!runId) {
    try {
      runId = (await getHookByToken(token)).runId
    } catch (error) {
      if (!HookNotFoundError.is(error)) throw error
    }
  }
  if (!runId) {
    const checked = await publishing.records.accept(accepted.command, now)
    if (!checked.ok) return json({ error: checked.error }, 409)
    runId = checked.runId
    if (!runId) {
      const { publishRun } = await import('../../../../../workflows/approval')
      try {
        runId = (
          await start(
            publishRun,
            [
              accepted.command.batchId,
              accepted.command.revision,
              { ownerUid, ...accepted.command },
            ],
            {
              experimental_hook: { token, experimental_minRetention: '36500d' },
            }
          )
        ).runId
      } catch (error) {
        if (!HookConflictError.is(error)) throw error
        runId = error.conflictingRunId
      }
    }
  }
  if (!runId) return json({ error: PUBLISH_ERRORS.unavailable }, 503)
  if (!(await publishing.records.bindRun(accepted.command, runId, now)))
    return json({ error: PUBLISH_ERRORS.superseded }, 409)
  return json({ status: 'publishing', runId }, 202)
}

/**
 * Authorize an owner to confirm or retry publishing from the batch revision they
 * reviewed.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/batches/[id]/publish'>
) {
  const auth = await currentActiveOwner(request)
  if (!auth.ok) return auth.response
  if (!publishAllowed()) return json({ error: 'publish_disabled_here' }, 403)
  const body = await readJson(request)
  if (
    typeof body?.revision !== 'number' ||
    !Number.isSafeInteger(body.revision) ||
    body.revision < 0
  )
    return badRequest()
  if (body.commandId !== undefined && !validCommandId(body.commandId))
    return badRequest()
  const { id } = await ctx.params
  const deps = reviewDeps()
  const publishing = publishDeps()
  const requestedBy = requesterAuthority(auth.actor)
  try {
    if (body.commandId) {
      const accepted = await publishing.records.command(body.commandId)
      if (accepted) {
        if (
          accepted.command.batchId !== id ||
          (accepted.command.confirmedDraftRevision ??
            accepted.command.revision) !== body.revision ||
          !sameRequester(accepted.command.requestedBy, requestedBy)
        )
          return json({ error: PUBLISH_ERRORS.superseded }, 409)
        return await dispatchRetry(
          publishing,
          accepted,
          auth.actor.uid,
          deps.now()
        )
      }
    }
    if (await publishing.records.pipelineBusy?.())
      return json({ error: PIPELINE_BUSY }, 409)
    const batch = await deps.store.getBatch(id)
    if (!batch) return json({ error: 'not_found' }, 404)
    const confirmDraft = draftCanBeConfirmed(batch)
    if (
      (!confirmDraft && batch.state !== 'approved') ||
      batch.revision !== body.revision
    ) {
      const confirmation = await deps.store.changesSinceReview?.(
        id,
        auth.actor.uid,
        batch.revision
      )
      return json({ error: 'superseded_revision', confirmation }, 409)
    }
    const control = await publishing.control.read()
    const stop = publishControlStop(control)
    if (stop) return json({ error: stop }, 409)
    const baseline = await publishBaselineStatus(publishing, batch)
    if (baseline.error) return json(baseline, 409)
    if (confirmDraft) {
      const reasons = await reviewApprovalProblems(deps, batch)
      if (reasons.length)
        return json({ error: 'standard_change_unconfirmed', reasons }, 409)
    }
    const command: PublishCommand = {
      batchId: id,
      revision: confirmDraft ? body.revision + 1 : body.revision,
      ...(confirmDraft ? { confirmedDraftRevision: body.revision } : {}),
      requestedBy,
      generation: control!.generation,
      commandId: body.commandId ?? randomUUID(),
    }
    const eligibility = await publishing.records.eligibility(
      command,
      deps.now()
    )
    if (eligibility.canRetry) {
      const accepted = await publishing.records.accept(command, deps.now())
      if (!accepted.ok) {
        if (accepted.error !== 'superseded_revision')
          return json({ error: accepted.error }, 409)
        const latest = await deps.store.getBatch(id)
        const confirmation = latest
          ? await deps.store.changesSinceReview?.(
              id,
              auth.actor.uid,
              latest.revision
            )
          : null
        return json({ error: accepted.error, confirmation }, 409)
      }
      if (confirmDraft && batch.state === 'submitted')
        await deps.supersedeRun?.(batch)
      return await dispatchRetry(
        publishing,
        accepted,
        auth.actor.uid,
        deps.now()
      )
    }
    if (confirmDraft || eligibility.reason !== PUBLISH_ERRORS.notWaiting)
      return json(
        {
          error: eligibility.reason,
          reviewedVersion: eligibility.reviewedVersion,
          liveVersion: eligibility.liveVersion,
        },
        409
      )
    const { batchId, revision, ...authority } = command
    try {
      await resumeHook(`publish:${batchId}:${revision}`, {
        ownerUid: auth.actor.uid,
        ...authority,
      })
    } catch {
      return json({ error: PUBLISH_ERRORS.notWaiting }, 409)
    }
    await deps.store.requestPublish(id, body.revision, deps.now(), requestedBy)
    return json({ status: 'publishing' }, 202)
  } catch {
    return json({ error: PUBLISH_ERRORS.unavailable }, 503)
  }
}

/**
 * Return publish confirmation or recovery eligibility for the current batch and release
 * state.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<'/api/batches/[id]/publish'>
) {
  const auth = await currentActiveOwner(request)
  if (!auth.ok) return auth.response
  const { id } = await ctx.params
  const deps = reviewDeps()
  const batch = await deps.store.getBatch(id)
  if (!batch) return json({ error: 'not_found' }, 404)
  try {
    const publishing = publishDeps()
    const control = await publishing.control.read()
    const confirmDraft = draftCanBeConfirmed(batch)
    const command = {
      batchId: id,
      revision: confirmDraft ? batch.revision + 1 : batch.revision,
      ...(confirmDraft ? { confirmedDraftRevision: batch.revision } : {}),
      commandId: randomUUID(),
      requestedBy: requesterAuthority(auth.actor),
      generation: control?.generation,
    }
    const eligibility = await publishing.records.eligibility(
      command,
      deps.now()
    )
    const receipt = await publishing.records.get(receiptId(id, batch.revision))
    const abandonReason =
      receipt && !receipt.committedAt
        ? await publishing.records.abandonmentEligibility(receipt, deps.now())
        : 'version_taken'
    const abandonment = batch.publishAbandonment
    const prepared =
      receipt &&
      !receipt.committedAt &&
      !['locked', 'superseded', 'unavailable'].includes(abandonReason ?? '')
        ? {
            commandId: publishCommandKey(receipt),
            toVersion: receipt.toVersion,
          }
        : undefined
    const reason =
      receipt && !receipt.committedAt
        ? await publishing.records.stopped(receipt)
        : null
    const stop = publishControlStop(control)
    const baseline = stop
      ? { error: stop }
      : await publishBaselineStatus(publishing, batch)
    const enabledHere = publishAllowed()
    const [pipelineBusy, confirmation] = await Promise.all([
      publishing.records.pipelineBusy?.(),
      deps.store.changesSinceReview?.(id, auth.actor.uid, batch.revision),
    ])
    const ready =
      enabledHere && !baseline.error && !pipelineBusy && eligibility.canRetry
    const approvalProblems =
      confirmDraft && ready ? await reviewApprovalProblems(deps, batch) : []
    return json({
      ...baseline,
      batchRevision: batch.revision,
      destination: process.env.GCP_PROJECT_ID ?? null,
      enabledHere,
      pipelineBusy,
      confirmation,
      approvalProblems,
      canConfirmDraft: confirmDraft && ready && approvalProblems.length === 0,
      canAbandon: enabledHere && !!prepared && !abandonReason,
      abandonReason,
      ...(prepared ? { prepared } : {}),
      ...(abandonment ? { abandonment } : {}),
      canRetry: !confirmDraft && ready,
      retryReason: eligibility.reason,
      ...(reason
        ? {
            stopped: {
              reason,
              ...(receipt?.requestedBy
                ? { requestedBy: receipt.requestedBy }
                : {}),
            },
          }
        : {}),
    })
  } catch {
    return json({ error: PUBLISH_ERRORS.unavailable }, 503)
  }
}
