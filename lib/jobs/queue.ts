import { createHash } from 'node:crypto'
import { canEdit } from '../review/batch'
import type { Actor, ReviewBatch } from '../review/types'
import { localJobsEnvironment } from './local-scope'
import { isPipelineStage } from './suggestions'
import {
  canonicalStages,
  planPipeline,
  pipelineNeedsModel,
  type RunStep,
} from './pipeline-plan'
import {
  defaultImageEnhancement,
  enhancementOperations,
} from './image-enhancement'
import {
  parsePipelineOptions,
  snapshotPipelineOptions,
} from './pipeline-options'
import { projectionMatchesBatch, snapshotProjection } from './queue-projection'
import type { JobsDeps, JobsTransaction, TaggingJob } from './types'
import type {
  EnqueueInput,
  PipelineRun,
  QueueOutcome,
  QueueRunView,
} from './queue-types'
import { chooseTaggingModel, enabledTaggingModels } from '../tagging/models'
import { completeGroupScope } from '../review/group-context'
import type { Plate } from '../catalog/types'
import { resolveResearchModel } from '../research/models'
import { pipelineChunkSize, pipelineSelectionLimit } from './pipeline-selection'
import { parallelGatewayTagPlan, parallelTagIndices } from './queue-parallel'
import {
  nextRunByRequester,
  queuedStageWait,
  queueResourceClaims,
  type QueueWorker,
} from './queue-claim'

export const queueStageTimeoutMs = 10 * 60_000
export const maxQueueRecordBytes = 650_000
export const maxQueueAttempts = 5
const requestPattern = /^[a-zA-Z0-9_-]{1,100}$/

/**
 * Require the local feature flag and its matching jobs environment before accepting
 * queue operations.
 */
export function localQueueEnabled(d: JobsDeps) {
  return (
    process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' &&
    !!d.localScope &&
    /^[a-zA-Z0-9_-]{1,80}$/.test(d.localScope) &&
    d.store.env === localJobsEnvironment(d.localScope)
  )
}

/**
 * Parse a queue request and freeze its options into the shape used for planning and
 * deduplication.
 */
export function parseEnqueue(
  input: unknown,
  limit = pipelineChunkSize
): EnqueueInput | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  const options = parsePipelineOptions(value.options)
  if (
    !options ||
    (value.previewOnly !== undefined &&
      typeof value.previewOnly !== 'boolean') ||
    Object.keys(value).some(
      (key) =>
        ![
          'requestId',
          'batchId',
          'plateIds',
          'stages',
          'modelId',
          'tagModelId',
          'researchModelId',
          'options',
          'previewOnly',
        ].includes(key)
    ) ||
    typeof value.requestId !== 'string' ||
    !requestPattern.test(value.requestId) ||
    typeof value.batchId !== 'string' ||
    !requestPattern.test(value.batchId) ||
    !Array.isArray(value.plateIds) ||
    !value.plateIds.length ||
    value.plateIds.length > limit ||
    value.plateIds.some(
      (id) => typeof id !== 'string' || !/^[a-zA-Z0-9._-]{1,180}$/.test(id)
    ) ||
    new Set(value.plateIds).size !== value.plateIds.length ||
    !Array.isArray(value.stages) ||
    !value.stages.length ||
    value.stages.length > canonicalStages.length ||
    value.stages.some(
      (stage) =>
        stage !== 'tag' && (!isPipelineStage(stage) || stage === 'order')
    ) ||
    new Set(value.stages).size !== value.stages.length ||
    ['modelId', 'tagModelId', 'researchModelId'].some(
      (key) =>
        value[key] !== undefined &&
        (typeof value[key] !== 'string' ||
          !requestPattern.test(value[key] as string))
    )
  )
    return null
  if (
    value.stages.includes('enhance-image') &&
    !enhancementOperations.some(
      (key) => (options['enhance-image'] ?? defaultImageEnhancement)[key]
    )
  )
    return null
  return {
    requestId: value.requestId,
    batchId: value.batchId,
    plateIds: value.plateIds as string[],
    stages: canonicalStages.filter((stage) =>
      (value.stages as unknown[]).includes(stage)
    ),
    options: snapshotPipelineOptions(value.stages as string[], options),
    previewOnly: value.previewOnly === true,
    ...(value.modelId ? { modelId: value.modelId as string } : {}),
    ...(value.tagModelId ? { tagModelId: value.tagModelId as string } : {}),
    ...(value.researchModelId
      ? { researchModelId: value.researchModelId as string }
      : {}),
  }
}

/** Check that a run fits the queue's storage budget before writing its growing record. */
export function queueRecordFits(run: PipelineRun) {
  return Buffer.byteLength(JSON.stringify(run), 'utf8') <= maxQueueRecordBytes
}

/** Check that the actor can edit the requested batch while it is open. */
export function queuePermission(
  batch: ReviewBatch | null,
  actor: Actor
): 'not_found' | 'forbidden' | 'invalid_state' | null {
  return !batch
    ? 'not_found'
    : !canEdit(batch, actor)
      ? 'forbidden'
      : batch.state !== 'open'
        ? 'invalid_state'
        : null
}

/**
 * Compose the current plate input from the batch's pinned baseline and its draft fields.
 */
export async function queuePlate(
  d: JobsDeps,
  tx: JobsTransaction,
  batchId: string,
  plateId: string
) {
  const review = await tx.review(batchId, plateId)
  const baseline =
    review && d.baselineAtVersion
      ? await d.baselineAtVersion(review.baselineVersion, plateId)
      : await d.baseline(plateId)
  return review && baseline ? { ...baseline, ...review.fields } : null
}

/**
 * Resolve the complete same-state grouping scope from the selected plates and their
 * current batch edits.
 */
export async function queueGroupContext(
  d: JobsDeps,
  tx: JobsTransaction,
  batch: ReviewBatch,
  selected: Plate[]
) {
  if (
    !selected.length ||
    !d.stateBaseline ||
    selected.some((plate) => !batch.plateIds.includes(plate.id)) ||
    new Set(selected.map((plate) => plate.state)).size !== 1
  )
    return null
  const baselines = await d.stateBaseline(
    batch.baselineVersion,
    selected[0].state,
    'snapshot'
  )
  const statePlates: Plate[] = []
  for (const baseline of baselines)
    statePlates.push(
      batch.plateIds.includes(baseline.id)
        ? ((await queuePlate(d, tx, batch.id, baseline.id)) ?? baseline)
        : baseline
    )
  if (!completeGroupScope(selected, statePlates)) return null
  return {
    statePlates,
    standardId: batch.stateOrders[selected[0].state]?.[0] ?? baselines[0]?.id,
  }
}

/**
 * Reload projected plates and compare their revisions so dispatch can reject stale
 * input.
 */
export async function currentProjectionMatches(
  d: JobsDeps,
  tx: JobsTransaction,
  run: PipelineRun,
  batch: ReviewBatch
) {
  const projection = run.attempts.at(-1)!.projection
  if (!projection) return false
  const plates = []
  for (const id of run.plateIds) {
    const plate = await queuePlate(d, tx, run.batchId, id)
    if (!plate) return false
    plates.push(plate)
  }
  return projectionMatchesBatch(projection, batch.baselineVersion, plates)
}

/**
 * Build an attempt with ordered work, compatible models and a snapshot of its starting
 * inputs.
 */
function buildRun(
  d: JobsDeps,
  actor: Actor,
  parsed: EnqueueInput,
  batch: ReviewBatch,
  plates: Plate[],
  id: string,
  fingerprint: string,
  enqueueSequence: number,
  now: number,
  selection?: { id: string; index: number }
): QueueOutcome<PipelineRun | null> {
  const steps = planPipeline(plates, parsed.stages, parsed.options!)
  if (!steps.length) return { ok: true, value: null }
  const needsModel = pipelineNeedsModel(
    steps.filter((step) => step.stage !== 'tag'),
    parsed.options!
  )
  const choice = needsModel
    ? chooseTaggingModel(
        parsed.modelId,
        enabledTaggingModels(process.env.TAGGING_MODELS).filter(
          (model) => model.runsOn === 'desktop'
        ),
        process.env.TAGGING_DEFAULT_MODEL
      )
    : undefined
  if (choice && !choice.ok)
    return {
      ok: false,
      error: choice.error === 'bad_request' ? 'bad_request' : 'invalid_state',
    }
  const tagChoice = steps.some((step) => step.stage === 'tag')
    ? chooseTaggingModel(
        parsed.tagModelId ?? parsed.modelId,
        enabledTaggingModels(process.env.TAGGING_MODELS),
        process.env.TAGGING_DEFAULT_MODEL
      )
    : undefined
  if (tagChoice && !tagChoice.ok)
    return {
      ok: false,
      error:
        tagChoice.error === 'bad_request' ? 'bad_request' : 'invalid_state',
    }
  if (tagChoice?.ok && tagChoice.model.runsOn === 'gateway')
    for (const step of steps)
      if (step.stage === 'tag') step.resourceClass = 'io'
  const research = steps.some((step) => step.stage === 'research')
    ? resolveResearchModel(
        parsed.researchModelId,
        process.env.RESEARCH_ENABLE_MODEL_CALLS === 'true',
        actor.role === 'owner'
      )
    : undefined
  if (research === null) return { ok: false, error: 'invalid_state' }
  if (research)
    for (const step of steps)
      if (step.stage === 'research')
        step.resourceClass = research.executor === 'desktop' ? 'gpu' : 'io'
  const savedInput = { ...parsed }
  delete savedInput.modelId
  delete savedInput.tagModelId
  delete savedInput.researchModelId
  const run: PipelineRun = {
    ...savedInput,
    ...(needsModel && choice?.ok
      ? { modelId: choice.model.id }
      : tagChoice?.ok
        ? { modelId: tagChoice.model.id }
        : {}),
    ...(tagChoice?.ok ? { tagModelId: tagChoice.model.id } : {}),
    ...(research ? { researchModel: research } : {}),
    id,
    fingerprint,
    env: d.store.env,
    localScope: d.localScope!,
    requestedBy: actor.uid,
    ...(selection
      ? {
          selectionId: selection.id,
          selectionIndex: selection.index,
          incrementalDrafts: !parsed.previewOnly,
          requestedByName: actor.name,
          requestedByRole: actor.role,
        }
      : {}),
    resourceClass: steps.some((step) => step.resourceClass === 'gpu')
      ? 'gpu'
      : 'io',
    options: parsed.options!,
    previewOnly: parsed.previewOnly!,
    createdAt: now,
    queuedAt: now,
    enqueueSequence,
    updatedAt: now,
    status: 'queued',
    waitReason: 'worker',
    attempts: [
      {
        number: 1,
        requestId: parsed.requestId,
        createdAt: now,
        jobIds: [],
        status: 'queued',
        cursor: 0,
        completedJobIds: [],
        steps,
        choices: {},
        ...(parallelGatewayTagPlan(
          parsed.stages,
          tagChoice?.ok ? tagChoice.model.id : undefined,
          steps.length
        )
          ? { parallelTag: true as const }
          : {}),
        projection: snapshotProjection(batch.baselineVersion, plates),
      },
    ],
  }
  if (!queueRecordFits(run)) return { ok: false, error: 'payload_too_large' }
  return { ok: true, value: run }
}

type NewBatch = { name: string; baselineVersion: number }

/** Hash serialized request data for reproducible queue request identities. */
function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * Plan and enqueue one or more runs transactionally, deduplicating retried requests and
 * creating a draft when needed.
 */
async function enqueueRuns(
  d: JobsDeps,
  actor: Actor,
  input: EnqueueInput,
  selected: boolean,
  draft?: NewBatch
): Promise<QueueOutcome<PipelineRun[]>> {
  if (!localQueueEnabled(d)) return { ok: false, error: 'forbidden' }
  const parsed = parseEnqueue(
    input,
    selected ? pipelineSelectionLimit : pipelineChunkSize
  )
  if (!parsed || (draft && parsed.previewOnly))
    return { ok: false, error: 'bad_request' }
  const fingerprint = JSON.stringify({
    batchId: parsed.batchId,
    plateIds: parsed.plateIds,
    stages: parsed.stages,
    modelId: parsed.modelId ?? null,
    ...(parsed.tagModelId ? { tagModelId: parsed.tagModelId } : {}),
    ...(parsed.researchModelId
      ? { researchModelId: parsed.researchModelId }
      : {}),
    options: parsed.options,
    previewOnly: parsed.previewOnly,
  })
  const requestFingerprint = selected
    ? hash([fingerprint, draft?.name ?? null])
    : fingerprint
  const id = hash([d.store.env, actor.uid, parsed.requestId])
  return d.store.transaction(async (tx) => {
    const runs = await tx.runs()
    const existing = runs.filter(
      (run) => run.id === id || run.selectionId === id
    )
    const storedBatch = await tx.batch(parsed.batchId)
    if (storedBatch && draft && storedBatch.createdBy !== actor.uid)
      return { ok: false, error: 'forbidden' }
    if (!storedBatch && (!draft || !tx.createDraftBatch))
      return { ok: false, error: 'not_found' }
    const now = d.now()
    const newBatch: ReviewBatch | null =
      draft && !storedBatch
        ? {
            id: parsed.batchId,
            name: draft.name,
            baselineVersion: draft.baselineVersion,
            createdAt: new Date(now).toISOString(),
            createdBy: actor.uid,
            createdByName: actor.name,
            plateIds: parsed.plateIds,
            state: 'open',
            revision: 0,
            stateOrders: {},
            approval: null,
          }
        : null
    const batch = storedBatch ?? newBatch!
    const error = queuePermission(batch, actor)
    if (error) return { ok: false, error }
    if (existing.length)
      return existing.every(
        (run) =>
          (run.fingerprint === requestFingerprint &&
            Boolean(run.selectionId) === selected) ||
          (selected &&
            !draft &&
            !run.selectionId &&
            run.fingerprint === fingerprint)
      )
        ? {
            ok: true,
            value: existing.sort(
              (a, b) => (a.selectionIndex ?? 0) - (b.selectionIndex ?? 0)
            ),
          }
        : { ok: false, error: 'request_mismatch' }
    if ((await tx.canQueue?.()) === false)
      return { ok: false, error: 'publish_in_progress' }
    if (
      new Set([...batch.plateIds, ...parsed.plateIds]).size >
      pipelineSelectionLimit
    )
      return { ok: false, error: 'invalid_state' }

    const edits = !newBatch
      ? await tx.reviewFields?.(batch.id, parsed.plateIds)
      : undefined
    const plates: Plate[] = []
    for (let offset = 0; offset < parsed.plateIds.length; offset += 50) {
      const ids = parsed.plateIds.slice(offset, offset + 50)
      const loaded = await Promise.all(
        ids.map(async (plateId) => {
          if (!newBatch && !edits) return queuePlate(d, tx, batch.id, plateId)
          const baseline = d.baselineAtVersion
            ? await d.baselineAtVersion(batch.baselineVersion, plateId)
            : await d.baseline(plateId)
          return baseline ? { ...baseline, ...edits?.get(plateId) } : null
        })
      )
      if (loaded.some((plate) => !plate))
        return { ok: false, error: 'not_found' }
      plates.push(...(loaded as Plate[]))
    }

    const group = parsed.stages.includes('group')
    if (group && !(await queueGroupContext(d, tx, batch, plates)))
      return { ok: false, error: 'invalid_state' }
    const size = group ? plates.length : pipelineChunkSize
    let sequence = runs.reduce(
      (max, run) => Math.max(max, run.enqueueSequence ?? 0),
      0
    )
    const chunks: PipelineRun[] = []
    let bytes = 0
    for (let offset = 0; offset < plates.length; offset += size) {
      const part = plates.slice(offset, offset + size)
      const index = chunks.length
      const result = buildRun(
        d,
        actor,
        { ...parsed, plateIds: part.map((plate) => plate.id) },
        batch,
        part,
        index ? hash([id, index]) : id,
        requestFingerprint,
        ++sequence,
        now,
        selected ? { id, index } : undefined
      )
      if (!result.ok) return result
      if (result.value) {
        bytes += Buffer.byteLength(JSON.stringify(result.value), 'utf8')
        chunks.push(result.value)
      }
    }
    if (!chunks.length) return { ok: false, error: 'invalid_state' }
    // Leave headroom below the Firestore transaction request limit.
    if (bytes > 7_000_000) return { ok: false, error: 'payload_too_large' }
    if (newBatch) await tx.createDraftBatch!(newBatch)
    for (const run of chunks) tx.setRun(run)
    return { ok: true, value: chunks }
  })
}

/** Enqueue one explicit pipeline run and return its record to the caller. */
export async function enqueueRun(
  d: JobsDeps,
  actor: Actor,
  input: EnqueueInput
): Promise<QueueOutcome<PipelineRun>> {
  const runs = await enqueueRuns(d, actor, input, false)
  return runs.ok ? { ok: true, value: runs.value[0] } : runs
}

/**
 * Enqueue a selection that may span grouped runs, optionally creating the draft batch in
 * the same transaction.
 */
export function enqueueSelection(
  d: JobsDeps,
  actor: Actor,
  input: EnqueueInput,
  draft?: NewBatch
): Promise<QueueOutcome<PipelineRun[]>> {
  return enqueueRuns(d, actor, input, true, draft)
}

function runView(
  run: PipelineRun,
  batch: ReviewBatch,
  jobs: TaggingJob[]
): QueueRunView {
  return {
    ...run,
    batchName: batch.name,
    jobs,
    editable: batch.state === 'open',
    applied:
      !!batch.pipelineApplications?.[
        `${run.id}:${run.attempts.at(-1)!.number}`
      ],
  }
}

export async function readPipelineRun(
  d: JobsDeps,
  actor: Actor,
  id: string
): Promise<QueueOutcome<QueueRunView>> {
  if (!localQueueEnabled(d)) return { ok: false, error: 'forbidden' }
  return d.store.transaction(async (tx) => {
    const run = await tx.getRun(id)
    if (
      !run ||
      run.localScope !== d.localScope ||
      (run.requestedBy !== actor.uid && actor.role !== 'owner')
    )
      return { ok: false, error: 'not_found' }
    const batch = await tx.batch(run.batchId)
    if (!batch || !canEdit(batch, actor))
      return { ok: false, error: 'not_found' }

    const ids = [...new Set(run.attempts.flatMap((attempt) => attempt.jobIds))]
    const jobs = tx.getMany
      ? await tx.getMany(ids)
      : await Promise.all(ids.map((jobId) => tx.get(jobId)))
    const scopedJobs = jobs.filter(
      (job): job is TaggingJob =>
        job !== null && job.localScope === d.localScope
    )
    return { ok: true, value: runView(run, batch, scopedJobs) }
  })
}

/** List the actor’s pipeline runs in the current worker scope. */
export async function listRuns(
  d: JobsDeps,
  actor: Actor,
  worker?: QueueWorker,
  detailId?: string | null
): Promise<QueueOutcome<QueueRunView[]>> {
  if (!localQueueEnabled(d)) return { ok: false, error: 'forbidden' }
  return d.store.transaction(async (tx) => {
    const scoped = (await tx.runs()).filter(
      (run) => run.localScope === d.localScope
    )
    const next = nextRunByRequester(scoped, d.localScope)
    const runs = scoped
      .filter((run) => run.requestedBy === actor.uid || actor.role === 'owner')
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    const jobs = await tx.list()
    const claims = worker ? queueResourceClaims(jobs, d.localScope) : []
    const now = d.now()
    const visible: QueueRunView[] = []
    // Reuse each batch read within this transaction when multiple runs share a batch.
    const batches = new Map<string, ReviewBatch | null>()
    for (const run of runs) {
      if (!batches.has(run.batchId))
        batches.set(run.batchId, await tx.batch(run.batchId))
      const batch = batches.get(run.batchId)
      if (!batch || !canEdit(batch, actor)) continue
      const ids = new Set(run.attempts.flatMap((attempt) => attempt.jobIds))
      const runJobs = jobs.filter(
        (job) => ids.has(job.id) && job.localScope === d.localScope
      )
      const attempt = run.attempts.at(-1)!
      const current = runJobs.find(
        (job) =>
          job.queueAttempt === attempt.number &&
          job.queueStep === attempt.cursor
      )
      const behindEarlierRun =
        run.status === 'queued' && next.get(run.requestedBy)?.id !== run.id
      const queueWait = behindEarlierRun
        ? 'prior_run'
        : worker
          ? queuedStageWait(run, current, claims, worker, now)
          : undefined
      visible.push({
        ...runView(run, batch, runJobs),
        ...(queueWait ? { queueWait } : {}),
      })
    }
    const retained = visible.filter((run) => run.dismissedAt === undefined)
    const archived = visible
      .filter((run) => run.dismissedAt !== undefined)
      .sort(
        (a, b) => b.dismissedAt! - a.dismissedAt! || a.id.localeCompare(b.id)
      )
    const history = archived.slice(0, 50)
    const requested = archived.find((run) => run.id === detailId)
    if (requested && !history.includes(requested)) history.push(requested)
    return { ok: true, value: [...retained, ...history] }
  })
}

/**
 * Close a run and its attempt, marking stages that never started with the reason they
 * were skipped.
 */
export function finishRun(
  run: PipelineRun,
  status: 'completed' | 'failed' | 'cancelled',
  now: number,
  error?: string
) {
  run.status = status
  run.updatedAt = now
  delete run.waitReason
  const attempt = run.attempts.at(-1)!
  Object.assign(attempt, { status, endedAt: now, ...(error ? { error } : {}) })
  if (status !== 'completed')
    for (const step of attempt.steps.slice(attempt.cursor)) {
      if (
        step.status === 'completed' ||
        step.status === 'cancelled' ||
        step.status === 'skipped'
      )
        continue
      step.status =
        status === 'failed' && step.index === attempt.cursor
          ? 'failed'
          : 'cancelled'
      step.endedAt = now
      step.reason =
        step.status === 'failed'
          ? (error ?? 'stage_failed')
          : status === 'failed'
            ? 'upstream_failed'
            : 'run_cancelled'
    }
}

/** Request cancellation and settle immediately when there is no active worker to stop. */
export async function cancelRun(
  d: JobsDeps,
  actor: Actor,
  id: string
): Promise<QueueOutcome<PipelineRun>> {
  if (!localQueueEnabled(d)) return { ok: false, error: 'forbidden' }
  return d.store.transaction(async (tx) => {
    const run = (await tx.runs()).find(
      (run) => run.id === id && run.localScope === d.localScope
    )
    if (!run) return { ok: false, error: 'not_found' }
    const error = queuePermission(await tx.batch(run.batchId), actor)
    if (error) return { ok: false, error }
    const attempt = run.attempts.at(-1)!
    if (run.status === 'cancelled' || run.cancelRequestedAt !== undefined)
      return { ok: true, value: run }
    if (!['queued', 'running'].includes(run.status))
      return { ok: false, error: 'invalid_state' }
    const ids = attempt.parallelTag
      ? parallelTagIndices(attempt).map(
          (index) => `${id}-${attempt.number}-${index}`
        )
      : attempt.jobIds.slice(-1)
    const jobs = (await Promise.all(ids.map((jobId) => tx.get(jobId)))).filter(
      (job) => job !== null
    )
    const now = d.now()
    run.cancelRequestedAt = now
    run.updatedAt = now
    for (const job of jobs)
      if (job.state === 'queued')
        tx.set({
          ...job,
          state: 'cancelled',
          endedAt: now,
          failure: 'cancelled_before_claim',
        })
    const settling = jobs.some(
      (job) =>
        job.state === 'claimed' ||
        (run.incrementalDrafts &&
          job.state === 'completed' &&
          job.queueAttempt === attempt.number &&
          (job.queueStep ?? -1) >= attempt.cursor)
    )
    if (settling) {
      run.status = 'running'
      attempt.status = 'running'
    } else finishRun(run, 'cancelled', now)
    tx.setRun(run)
    return { ok: true, value: run }
  })
}

export async function dismissRun(
  d: JobsDeps,
  actor: Actor,
  id: string
): Promise<QueueOutcome<PipelineRun>> {
  if (!localQueueEnabled(d)) return { ok: false, error: 'forbidden' }
  return d.store.transaction(async (tx) => {
    const run = await tx.getRun(id)
    if (
      !run ||
      run.localScope !== d.localScope ||
      (run.requestedBy !== actor.uid && actor.role !== 'owner')
    )
      return { ok: false, error: 'not_found' }
    const batch = await tx.batch(run.batchId)
    if (!batch) return { ok: false, error: 'not_found' }
    if (!canEdit(batch, actor)) return { ok: false, error: 'forbidden' }
    if (!['completed', 'failed', 'cancelled'].includes(run.status))
      return { ok: false, error: 'invalid_state' }
    const idOfLastJob = run.attempts.at(-1)?.jobIds.at(-1)
    if (idOfLastJob && (await tx.get(idOfLastJob))?.state === 'claimed')
      return { ok: false, error: 'invalid_state' }
    if (run.dismissedAt === undefined) {
      run.dismissedAt = d.now()
      tx.setRun(run)
    }
    return { ok: true, value: run }
  })
}

/**
 * Build another attempt for an eligible run using fresh inputs and an idempotent retry
 * request.
 */
export async function retryRun(
  d: JobsDeps,
  actor: Actor,
  id: string,
  requestId: string
): Promise<QueueOutcome<PipelineRun>> {
  if (!localQueueEnabled(d)) return { ok: false, error: 'forbidden' }
  if (!requestPattern.test(requestId))
    return { ok: false, error: 'bad_request' }
  return d.store.transaction(async (tx) => {
    const runs = await tx.runs()
    const run = runs.find(
      (run) => run.id === id && run.localScope === d.localScope
    )
    if (!run) return { ok: false, error: 'not_found' }
    const batch = await tx.batch(run.batchId)
    const error = queuePermission(batch, actor)
    if (error) return { ok: false, error }
    if (run.attempts.some((attempt) => attempt.requestId === requestId))
      return { ok: true, value: run }
    const previous = run.attempts.at(-1)!
    if (
      !['failed', 'cancelled'].includes(run.status) &&
      !(run.status === 'completed' && previous.outcome === 'partial')
    )
      return { ok: false, error: 'invalid_state' }
    if (run.attempts.length >= maxQueueAttempts)
      return { ok: false, error: 'attempt_limit' }
    for (const id of previous.jobIds)
      if ((await tx.get(id))?.state === 'claimed')
        return { ok: false, error: 'invalid_state' }
    if (!(await currentProjectionMatches(d, tx, run, batch!)))
      return { ok: false, error: 'stale_input' }
    const steps = previous.steps.map<RunStep>((step) => {
      if (
        step.status === 'skipped' &&
        step.reason !== 'upstream_failed' &&
        step.reason !== 'group_member_failed'
      )
        return step
      if (
        step.status === 'completed' ||
        (!step.status && step.index < previous.cursor)
      ) {
        const completedJobId =
          step.completedJobId ?? previous.completedJobIds[step.index]
        return {
          ...step,
          status: 'completed',
          ...(completedJobId ? { completedJobId } : {}),
        }
      }
      return {
        index: step.index,
        plateId: step.plateId,
        stage: step.stage,
        resourceClass: step.resourceClass,
      }
    })
    const cursor = steps.findIndex(
      (step) => step.status !== 'completed' && step.status !== 'skipped'
    )
    if (cursor < 0) return { ok: false, error: 'invalid_state' }
    if ((await tx.canQueue?.()) === false)
      return { ok: false, error: 'publish_in_progress' }
    const now = d.now()
    run.attempts.push({
      number: previous.number + 1,
      requestId,
      createdAt: now,
      jobIds: [...previous.completedJobIds],
      completedJobIds: [...previous.completedJobIds],
      status: 'queued',
      cursor,
      ...(previous.parallelTag ? { parallelTag: true } : {}),
      ...(previous.noResultCount
        ? { noResultCount: previous.noResultCount }
        : {}),
      steps,
      choices: { ...previous.choices },
      projection: structuredClone(previous.projection!),
    })
    run.status = 'queued'
    run.queuedAt = now
    run.updatedAt = now
    run.waitReason = 'worker'
    run.enqueueSequence =
      Math.max(0, ...runs.map((run) => run.enqueueSequence ?? 0)) + 1
    delete run.cancelRequestedAt
    delete run.dismissedAt
    if (!queueRecordFits(run)) return { ok: false, error: 'payload_too_large' }
    tx.setRun(run)
    return { ok: true, value: run }
  })
}
