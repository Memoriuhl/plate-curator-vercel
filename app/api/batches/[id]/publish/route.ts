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
import { getHookByToken, start } from 'workflow/api'
import { HookConflictError, HookNotFoundError } from 'workflow/errors'
import {
  currentActiveOwner,
  requesterAuthority,
  publishAllowed,
  publishDeps,
  reviewDeps,
  reviewEnv,
} from '../../../../../lib/server/context'
import { reviewApprovalProblems } from '../../../../../lib/review/batch'
import { publishBaselineStatus } from '../../../../../lib/publish/baseline-status'
import { badRequest, json, readJson } from '../../../../../lib/server/respond'
import { batchStepRetired } from '../../../../../lib/server/retired'
import {
  isRelease,
  isSharedDraftId,
  sharedDraftId,
} from '../../../../../lib/review/draft-id'
import { ensureDraft, freezeRelease } from '../../../../../lib/review/draft'
import { draftPublishSummary } from '../../../../../lib/review/publish-view'
import type {
  Actor,
  ReviewBatch,
  ReviewDeps,
} from '../../../../../lib/review/types'

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
              // Vercel Workflow caps start-hook retention at 30 days.
              experimental_hook: { token, experimental_minRetention: '30d' },
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
    if (isSharedDraftId(id))
      return await publishDraft(
        deps,
        publishing,
        auth.actor,
        requestedBy,
        body.revision,
        body.commandId
      )
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
      return await pipelineBusyResponse(publishing)
    const batch = await deps.store.getBatch(id)
    if (!batch) return json({ error: 'not_found' }, 404)
    return await confirmBatch(
      deps,
      publishing,
      auth.actor,
      requestedBy,
      batch,
      body.revision,
      body.commandId
    )
  } catch {
    return json({ error: PUBLISH_ERRORS.unavailable }, 503)
  }
}

/** Refuse a Publish while pipeline work is queued or running, and say how much remains. */
async function pipelineBusyResponse(publishing: PublishDeps) {
  const activeRuns = await publishing.records
    .activePipelineRuns?.()
    .catch(() => undefined)
  return json(
    { error: PIPELINE_BUSY, ...(activeRuns ? { activeRuns } : {}) },
    409
  )
}

/**
 * Publish the shared draft at the revision the Owner reviewed: freeze that revision into
 * a release and confirm it through the Owner publish path. A retry with the same command
 * resumes the same release.
 */
async function publishDraft(
  deps: ReviewDeps,
  publishing: PublishDeps,
  actor: Actor,
  requestedBy: ReturnType<typeof requesterAuthority>,
  revision: number,
  commandId?: string
) {
  const env = reviewEnv()
  const draftId = sharedDraftId(env)
  if (commandId) {
    const accepted = await publishing.records.command(commandId)
    if (accepted) {
      const release = await deps.store.getBatch(accepted.command.batchId)
      if (
        !release ||
        !isRelease(release) ||
        release.source?.batchId !== draftId ||
        release.source.revision !== revision ||
        !sameRequester(accepted.command.requestedBy, requestedBy)
      )
        return json({ error: PUBLISH_ERRORS.superseded }, 409)
      return await dispatchRetry(publishing, accepted, actor.uid, deps.now())
    }
  }
  if (await publishing.records.pipelineBusy?.())
    return await pipelineBusyResponse(publishing)
  const draft = await ensureDraft(deps, env, actor)
  const frozen = await freezeRelease(deps, env, actor, revision)
  if (!frozen.ok) {
    if (frozen.error !== 'superseded_revision')
      return json({ error: frozen.error }, 409)
    const confirmation = await deps.store.changesSinceReview?.(
      draftId,
      actor.uid,
      draft.revision
    )
    return json({ error: 'superseded_revision', confirmation }, 409)
  }
  return confirmBatch(
    deps,
    publishing,
    actor,
    requestedBy,
    frozen.value,
    frozen.value.revision,
    commandId
  )
}

/**
 * Accept the Owner's Publish command for a release (or retry an accepted one) and start
 * the publish workflow.
 */
async function confirmBatch(
  deps: ReviewDeps,
  publishing: PublishDeps,
  actor: Actor,
  requestedBy: ReturnType<typeof requesterAuthority>,
  batch: ReviewBatch,
  revision: number,
  commandId?: string
) {
  const id = batch.id
  // Old Batches can still finish a publish they started, but only a release made from
  // the shared draft can be confirmed.
  const confirmDraft = draftCanBeConfirmed(batch)
  if (confirmDraft && !isRelease(batch)) return batchStepRetired()
  if (
    (!confirmDraft && batch.state !== 'approved') ||
    batch.revision !== revision
  ) {
    const confirmation = await deps.store.changesSinceReview?.(
      id,
      actor.uid,
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
    revision: confirmDraft ? revision + 1 : revision,
    ...(confirmDraft ? { confirmedDraftRevision: revision } : {}),
    requestedBy,
    generation: control!.generation,
    commandId: commandId ?? randomUUID(),
  }
  const eligibility = await publishing.records.eligibility(command, deps.now())
  if (!eligibility.canRetry)
    return json(
      {
        error: eligibility.reason,
        reviewedVersion: eligibility.reviewedVersion,
        liveVersion: eligibility.liveVersion,
      },
      409
    )
  const accepted = await publishing.records.accept(command, deps.now())
  if (!accepted.ok) {
    if (accepted.error !== 'superseded_revision')
      return json({ error: accepted.error }, 409)
    const latest = await deps.store.getBatch(id)
    const confirmation = latest
      ? await deps.store.changesSinceReview?.(id, actor.uid, latest.revision)
      : null
    return json({ error: accepted.error, confirmation }, 409)
  }
  return dispatchRetry(publishing, accepted, actor.uid, deps.now())
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
  if (isSharedDraftId(id)) {
    try {
      return await draftPublishView(deps, publishDeps(), auth.actor)
    } catch {
      return json({ error: PUBLISH_ERRORS.unavailable }, 503)
    }
  }
  const batch = await deps.store.getBatch(id)
  if (!batch) return json({ error: 'not_found' }, 404)
  try {
    const publishing = publishDeps()
    const control = await publishing.control.read()
    // Only a release frozen from the shared draft can be confirmed; older Batches can
    // still be retried or abandoned.
    const confirmDraft = draftCanBeConfirmed(batch) && isRelease(batch)
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

/**
 * The Owner's Publish view of the shared draft: the revision that Publish will ship, what
 * each state changes, and why Publish is blocked when it is. A release that is already
 * publishing is returned so the view can follow it.
 */
async function draftPublishView(
  deps: ReviewDeps,
  publishing: PublishDeps,
  actor: Actor
) {
  const env = reviewEnv()
  const draft = await ensureDraft(deps, env, actor)
  const [snapshot, control, busy, activeRuns, active] = await Promise.all([
    deps.store.readBatch(draft.id),
    publishing.control.read(),
    publishing.records.pipelineBusy?.(),
    publishing.records.activePipelineRuns?.().catch(() => undefined),
    deps.store.list({ states: ['approved'] }),
  ])
  if (!snapshot) return json({ error: 'not_found' }, 404)
  const changes =
    (await deps.store.listChanges?.(
      draft.id,
      draft.lastPublish?.revision ?? draft.rebaseFloor ?? 0
    )) ?? []
  const states = draftPublishSummary(snapshot, changes)
  const stop = publishControlStop(control)
  const baseline = stop
    ? { error: stop }
    : await publishBaselineStatus(publishing, snapshot.batch)
  const enabledHere = publishAllowed()
  const activeRelease = active
    .filter(
      (batch) => isRelease(batch) && batch.source?.batchId === snapshot.batch.id
    )
    .sort(
      (left, right) =>
        (right.source?.revision ?? 0) - (left.source?.revision ?? 0)
    )[0]
  const empty = states.length === 0
  const approvalProblems =
    enabledHere && !baseline.error && !busy && !empty
      ? await reviewApprovalProblems(deps, snapshot.batch)
      : []
  return json({
    ...baseline,
    draftId: snapshot.batch.id,
    draftRevision: snapshot.batch.revision,
    baselineVersion: snapshot.batch.baselineVersion,
    destination: process.env.GCP_PROJECT_ID ?? null,
    enabledHere,
    states,
    pipeline: {
      busy: !!busy,
      ...(busy && activeRuns ? { activeRuns } : {}),
    },
    approvalProblems,
    ...(snapshot.batch.lastPublish
      ? { lastPublish: snapshot.batch.lastPublish }
      : {}),
    ...(activeRelease
      ? {
          activeRelease: {
            id: activeRelease.id,
            revision: activeRelease.source?.revision,
          },
        }
      : {}),
    canPublish:
      enabledHere &&
      !baseline.error &&
      !busy &&
      !empty &&
      !activeRelease &&
      approvalProblems.length === 0,
  })
}
