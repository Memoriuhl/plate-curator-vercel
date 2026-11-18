import { currentProjectionMatches, finishRun, localQueueEnabled, queuePermission, queueRecordFits, queueGroupContext } from './queue'
import { plateRevision } from '../review/revision'
import { projectJob, type ProjectedPlate } from './queue-projection'
import type { Actor } from '../review/types'
import { canEdit } from '../review/access'
import type { JobsDeps, JobsTransaction, TaggingJob } from './types'
import type { PipelineRun, QueueOutcome, RunAttempt } from './queue-types'
import { isPlateFailure, pipelineNeedsModel, type RunStep } from './pipeline-plan'
import { storyUrl } from '../review/fields'
import { taggingModel } from '../tagging/models'
import { verifiedImageFields } from '../review/image'
import { saveQueueDraft } from './queue-draft'
import { shouldReuseSavedSources } from '../research/enrichment'
import { workflowVisibilityUrl } from './workflow-visibility'

export type StageObservation = { phase: 'done' | 'next' | 'waiting' | 'claimed'; deadline?: number; nextIndex?: number }

/** Load a queue run only from the local scope assigned to the current executor. */
async function scopedRun(tx: JobsTransaction, id: string, scope: string | undefined) {
  const run = await tx.getRun(id)
  return run && run.localScope === scope ? run : null
}

function advanceCursor(run: PipelineRun, attempt: RunAttempt, now: number) {
  attempt.cursor++
  while (attempt.steps[attempt.cursor]?.status === 'completed' || attempt.steps[attempt.cursor]?.status === 'cancelled' || attempt.steps[attempt.cursor]?.status === 'skipped') attempt.cursor++
  delete attempt.error
  if (attempt.cursor === attempt.steps.length) {
    const failures = attempt.steps.filter(step => step.status === 'failed')
    if (failures.length) {
      const failedPlateIds = new Set(failures.map(step => step.plateId))
      const finished = attempt.steps.some(step => step.status === 'completed' && !failedPlateIds.has(step.plateId))
      const savedDrafts = run.incrementalDrafts && !run.previewOnly && !!run.draftPlateIds?.length
      attempt.outcome = finished || savedDrafts ? 'partial' : 'no_result'
      finishRun(run, finished ? 'completed' : 'failed', now, failures[0].reason)
    } else {
      if (attempt.noResultCount) attempt.outcome = attempt.steps.some(step => step.status === 'completed') ? 'partial' : 'no_result'
      finishRun(run, 'completed', now)
    }
    return
  }
  run.updatedAt = now
  run.waitReason = 'worker'
  run.status = 'queued'
}

/**
 * Record a completed job and move the attempt to the next stage or its terminal outcome.
 */
function advanceStage(run: PipelineRun, attempt: RunAttempt, jobId: string, now: number, skipReason?: string) {
  attempt.completedJobIds.push(jobId)
  Object.assign(attempt.steps[attempt.cursor], {
    status: skipReason ? 'skipped' : 'completed', completedJobId: jobId, endedAt: now,
    ...(skipReason ? { reason: skipReason } : {}),
  })
  if (skipReason) {
    attempt.noResultCount = (attempt.noResultCount ?? 0) + 1
    skipRemainingPlateSteps(attempt, 'upstream_skipped', now)
  }
  advanceCursor(run, attempt, now)
}

function failPlateStage(run: PipelineRun, attempt: RunAttempt, reason: string, now: number) {
  Object.assign(attempt.steps[attempt.cursor], { status: 'failed', reason, endedAt: now })
  skipRemainingPlateSteps(attempt, 'upstream_failed', now)
  advanceCursor(run, attempt, now)
}

function skipRemainingPlateSteps(attempt: RunAttempt, reason: 'upstream_failed' | 'upstream_skipped', now: number) {
  const { plateId } = attempt.steps[attempt.cursor]
  for (const step of attempt.steps.slice(attempt.cursor + 1)) {
    if (step.status === 'completed' || step.status === 'cancelled') continue
    if (step.stage === 'group') {
      if (step.reason === 'group_member_skipped') continue
      Object.assign(step, { status: 'skipped', reason: reason === 'upstream_failed' ? 'group_member_failed' : 'group_member_skipped', endedAt: now })
    } else if (step.plateId === plateId) {
      Object.assign(step, { status: 'skipped', reason, endedAt: now })
    }
  }
}

function nextStage(attempt: RunAttempt, index: number): StageObservation {
  return { phase: 'next', ...(attempt.cursor > index + 1 ? { nextIndex: attempt.cursor } : {}) }
}

/**
 * Check that description and story stages can use valid results from earlier stages of
 * the same attempt.
 */
function missingResearchInput(attempt: RunAttempt, step: RunStep, plate: ProjectedPlate): string | undefined {
  if (step.stage !== 'describe' && step.stage !== 'story') return
  /**
   * Find an earlier stage for this plate so the dependency is tied to the current
   * attempt.
   */
  const preceding = (stage: 'wiki-link' | 'describe') => attempt.steps.find(candidate =>
    candidate.index < step.index && candidate.plateId === step.plateId && candidate.stage === stage)
  const wiki = preceding('wiki-link')
  if (wiki && (!storyUrl(plate.executionPlate.wikiUrl) || !plate.sourceJobIds.includes(wiki.completedJobId ?? attempt.completedJobIds[wiki.index]))) return 'missing_wiki_link'
  if (step.stage === 'story') {
    const describe = preceding('describe')
    if (describe && (!plate.executionPlate.description?.trim() || !plate.sourceJobIds.includes(describe.completedJobId ?? attempt.completedJobIds[describe.index]))) return 'missing_description'
  }
}

/**
 * Bind a workflow ID to the active attempt so a competing or stale workflow cannot take
 * over.
 */
export async function bindQueueWorkflow(d: JobsDeps, id: string, number: number, workflowId: string): Promise<boolean> {
  if (!localQueueEnabled(d)) return false
  return d.store.transaction(async tx => {
    const run = await scopedRun(tx, id, d.localScope)
    const attempt = run?.attempts.at(-1)
    if (!run || !attempt || attempt.number !== number || !['queued', 'running'].includes(run.status) || attempt.workflowId && attempt.workflowId !== workflowId) return false
    attempt.workflowId = workflowId
    attempt.workflowUrl = workflowVisibilityUrl(workflowId, process.env.VERCEL_ENV, process.env.WORKFLOW_TARGET_WORLD)
    run.updatedAt = d.now(); tx.setRun(run)
    return true
  })
}

/**
 * Queue the current stage if its input is valid and reuse its existing job when the
 * workflow retries.
 */
export async function dispatchQueueStage(d: JobsDeps, id: string, number: number, index: number, completionHook: string): Promise<string | null> {
  if (!localQueueEnabled(d)) return null
  return d.store.transaction(async tx => {
    const run = await scopedRun(tx, id, d.localScope)
    const attempt = run?.attempts.at(-1)
    if (!run || !attempt || attempt.number !== number || attempt.cursor !== index || !['queued', 'running'].includes(run.status)) return null
    const step = attempt.steps[index]
    if (!step) return null
    const jobId = `${id}-${number}-${index}`
    if (await tx.get(jobId)) return jobId
    const batch = await tx.batch(run.batchId)
    const projected = attempt.projection?.plates[step.plateId]
    let error: string | undefined
    if (!batch || batch.state !== 'open') error = 'batch_read_only'
    else if (!projected || batch.baselineVersion !== attempt.projection?.baselineVersion || ((!run.incrementalDrafts || run.previewOnly || step.stage === 'group') && !await currentProjectionMatches(d, tx, run, batch))) error = 'stale_input'
    const groupContext = step.stage === 'group' && batch ? await queueGroupContext(d, tx, batch, Object.values(attempt.projection!.plates).map(entry => entry.batchInput)) : null
    if (step.stage === 'group' && !groupContext) error = 'invalid_group_scope'
    if (run.cancelRequestedAt !== undefined || error || !projected) {
      finishRun(run, run.cancelRequestedAt !== undefined ? 'cancelled' : 'failed', d.now(), error)
      tx.setRun(run); return null
    }
    const missing = missingResearchInput(attempt, step, projected)
    if (missing) {
      failPlateStage(run, attempt, missing, d.now())
      tx.setRun(run)
      return null
    }
    const modelId = step.stage === 'research' ? run.researchModel?.id : step.stage === 'tag' ? run.tagModelId ?? run.modelId : run.modelId
    const hosted = step.stage === 'research' ? run.researchModel?.executor === 'eve' : step.stage === 'tag' && taggingModel(modelId)?.runsOn === 'gateway'
    const job: TaggingJob = { id: jobId, batchId: run.batchId, plateId: step.plateId, requestedBy: run.requestedBy, enqueuedBy: run.requestedBy,
      env: d.store.env, localScope: d.localScope!, queueRunId: id, previewOnly: run.previewOnly, queueAttempt: number, queueStep: index, resourceClass: step.resourceClass,
      queueOrder: run.enqueueSequence,
      ...(attempt.workflowId ? { workflowId: attempt.workflowId, workflowUrl: attempt.workflowUrl } : {}),
      createdAt: d.now(), state: 'queued', inputPlate: projected.executionPlate, inputHash: projected.batchInputHash, executionHash: projected.executionHash,
      completionHook, ...(hosted ? { route: 'hosted' as const } : {}), ...(step.stage === 'tag' ? {} : { stage: step.stage }), ...(modelId && pipelineNeedsModel([step], run.options) ? { modelId } : {}),
      ...(step.stage === 'research' ? { researchModel: run.researchModel, researchPolicy: run.options.research?.policy ?? 'fill-missing' } : {}),
      ...(run.options[step.stage as keyof typeof run.options] ? { stageOptions: run.options[step.stage as keyof typeof run.options] } : {}),
      ...(step.stage === 'group' ? { groupScope: Object.values(attempt.projection!.plates).map(entry => ({ plate: entry.executionPlate, baseRevision: entry.batchInputHash })), ...(groupContext?.standardId ? { standardId: groupContext.standardId } : {}) } : {}),
    }
    attempt.jobIds.push(jobId); attempt.status = 'running'; run.waitReason = hosted ? 'resource' : 'worker'; run.updatedAt = d.now()
    if (hosted) run.status = 'running'
    if (!queueRecordFits(run)) { finishRun(run, 'failed', d.now(), 'payload_too_large'); tx.setRun(run); return null }
    tx.create(job); tx.setRun(run)
    return jobId
  })
}

/**
 * Observe the current stage and settle finished jobs so the workflow can wait, advance
 * or stop.
 */
export async function observeQueueStage(d: JobsDeps, id: string, number: number, index: number, readImage?: Parameters<typeof verifiedImageFields>[1]): Promise<StageObservation> {
  if (!localQueueEnabled(d)) return { phase: 'done' }
  let imageVerification: ReturnType<typeof verifiedImageFields> | undefined
  return d.store.transaction(async tx => {
    const run = await scopedRun(tx, id, d.localScope)
    const attempt = run?.attempts.at(-1)
    if (!run || !attempt || attempt.number !== number || !['queued', 'running'].includes(run.status)) return { phase: 'done' }
    if (attempt.cursor !== index) return attempt.cursor > index ? nextStage(attempt, index) : { phase: 'done' }
    const job = await tx.get(`${id}-${number}-${index}`)
    if (!job || job.queueRunId !== run.id || job.queueAttempt !== number || job.queueStep !== index ||
      job.batchId !== run.batchId || job.localScope !== d.localScope || job.requestedBy !== run.requestedBy ||
      job.plateId !== attempt.steps[index]?.plateId) { finishRun(run, 'failed', d.now(), 'job_missing'); tx.setRun(run); return { phase: 'done' } }
    if (job.state === 'queued') return { phase: 'waiting' }
    if (job.state === 'claimed') {
      if (job.leaseExpiresAt! <= d.now()) {
        if (job.recoveryNeededAt === undefined) {
          tx.set({ ...job, recoveryNeededAt: d.now() }); run.waitReason = 'recovery'; run.updatedAt = d.now()
          attempt.error = 'lease_expired_waiting_for_worker'; tx.setRun(run)
        }
        return { phase: 'waiting' }
      }
      if (run.waitReason !== 'inference') { run.waitReason = 'inference'; run.updatedAt = d.now(); tx.setRun(run) }
      return { phase: 'claimed', deadline: job.leaseExpiresAt }
    }
    const observation = await settleQueueStage(d, tx, run, attempt, job, candidate => imageVerification ??= verifiedImageFields(candidate, readImage))
    tx.setRun(run)
    return observation
  })
}

/**
 * Project a completed stage result into the run and persist eligible draft edits before
 * advancing.
 */
async function settleQueueStage(
  d: JobsDeps, tx: JobsTransaction, run: PipelineRun, attempt: RunAttempt, job: TaggingJob,
  verifyImage: typeof verifiedImageFields,
): Promise<StageObservation> {
  let error = job.failure
  const cancelled = run.cancelRequestedAt !== undefined
  const shouldSave = run.incrementalDrafts && !run.previewOnly
  if (cancelled && (!shouldSave || job.state !== 'completed' || job.result?.stageError || job.result?.backend === 'missing-image' ||
    job.result?.fieldSuggestion?.kind === 'image' && !attempt.choices[job.id])) finishRun(run, 'cancelled', d.now())
  else if (job.state !== 'completed') {
    if (job.state === 'failed' && job.stage !== 'group' && error && isPlateFailure(error)) failPlateStage(run, attempt, error, d.now())
    else finishRun(run, 'failed', d.now(), error ?? 'stage_failed')
  } else if (job.stage === 'research' && job.result?.stageError === 'no_sources' &&
    shouldReuseSavedSources({ ...job.stageOptions, policy: job.researchPolicy })) {
    advanceStage(run, attempt, job.id, d.now(), 'no_saved_sources')
  } else if (job.result?.stageError || job.result?.backend === 'missing-image') {
    const reason = job.result.stageError ?? 'missing_image'
    if (job.stage !== 'group' && isPlateFailure(reason)) failPlateStage(run, attempt, reason, d.now())
    else finishRun(run, 'failed', d.now(), reason)
  } else {
    const raw = job.result?.fieldSuggestion
    const candidateId = attempt.choices[job.id]
    if (raw?.kind === 'image' && !candidateId) {
      if (run.waitReason !== 'image_choice') { run.status = 'running'; run.waitReason = 'image_choice'; run.updatedAt = d.now() }
      return { phase: 'waiting' }
    }
    const original = attempt.projection!
    let projected = projectJob(original, job)
    const candidate = raw?.kind === 'image' ? raw.candidates?.find(candidate => candidate.id === candidateId) : undefined
    if (raw?.kind === 'image' && candidateId) {
      const entry = original.plates[job.plateId]
      if (candidate && entry.batchInputHash === job.inputHash && entry.executionHash === job.executionHash) {
        const executionPlate = { ...entry.executionPlate, imageUrl: candidate.imageUrl, sourceUrl: candidate.sourceUrl }
        projected = { ok: true, value: { ...original, plates: { ...original.plates, [job.plateId]: { ...entry, executionPlate,
          executionHash: plateRevision(executionPlate), sourceJobIds: [...entry.sourceJobIds, job.id] } } } }
      }
    }
    if (!projected.ok) error = projected.error
    else if (shouldSave) {
      if (candidate && !await verifyImage(candidate)) error = 'invalid_result'
      else {
        const saved = await saveQueueDraft(d, tx, run, job, original, projected.value, candidate)
        if ('error' in saved) error = saved.error
        else {
          attempt.projection = saved.projection
          if (saved.changedPlateIds.length) run.draftPlateIds = [...new Set([...(run.draftPlateIds ?? []), ...saved.changedPlateIds])]
          if (saved.conflict) error = 'draft_conflict'
          else advanceStage(run, attempt, job.id, d.now())
        }
      }
    } else {
      attempt.projection = projected.value
      if (!queueRecordFits(run)) { attempt.projection = original; error = 'payload_too_large' }
      else advanceStage(run, attempt, job.id, d.now())
    }
    if (cancelled) finishRun(run, 'cancelled', d.now(), error)
    else if (error) finishRun(run, 'failed', d.now(), error)
  }
  return run.status === 'queued' ? nextStage(attempt, job.queueStep!) : { phase: 'done' }
}

/**
 * Record which candidate image the curator chose so the paused image stage can continue.
 */
export async function chooseQueueImage(d: JobsDeps, actor: Actor, id: string, jobId: string, candidateId: string): Promise<QueueOutcome<PipelineRun>> {
  if (!localQueueEnabled(d)) return { ok: false, error: 'forbidden' }
  return d.store.transaction(async tx => {
    const run = await scopedRun(tx, id, d.localScope)
    if (!run) return { ok: false, error: 'not_found' }
    const batch = await tx.batch(run.batchId)
    const error = queuePermission(batch, actor)
    if (error) return { ok: false, error }
    const job = await tx.get(jobId)
    const attempt = run.attempts.at(-1)!
    const raw = job?.result?.fieldSuggestion
    if (!job || job.queueRunId !== run.id || job.queueAttempt !== attempt.number || job.queueStep !== attempt.cursor || job.state !== 'completed' ||
      raw?.kind !== 'image' || !raw.candidates?.some(candidate => candidate.id === candidateId) || run.cancelRequestedAt !== undefined) return { ok: false, error: 'invalid_state' }
    if (batch!.baselineVersion !== attempt.projection?.baselineVersion ||
      ((!run.incrementalDrafts || run.previewOnly) && !await currentProjectionMatches(d, tx, run, batch!))) return { ok: false, error: 'stale_input' }
    if (attempt.choices[job.id] && attempt.choices[job.id] !== candidateId) return { ok: false, error: 'invalid_state' }
    attempt.choices[job.id] = candidateId; run.updatedAt = d.now(); tx.setRun(run)
    return { ok: true, value: run }
  })
}

/** Confirm a stopped worker claim before releasing a cancelled run for recovery. */
export async function confirmStoppedWorker(d: JobsDeps, actor: Actor, id: string, jobId: string, claimId: string): Promise<QueueOutcome<PipelineRun>> {
  if (!localQueueEnabled(d)) return { ok: false, error: 'forbidden' }
  return d.store.transaction(async tx => {
    const run = await scopedRun(tx, id, d.localScope)
    if (!run) return { ok: false, error: 'not_found' }
    const batch = await tx.batch(run.batchId)
    if (!batch) return { ok: false, error: 'not_found' }
    if (!canEdit(batch, actor)) return { ok: false, error: 'forbidden' }
    const job = await tx.get(jobId)
    const attempt = run.attempts.at(-1)!
    if (!job || job.queueRunId !== run.id || job.queueAttempt !== attempt.number || job.queueStep !== attempt.cursor || job.claimId !== claimId ||
      job.state !== 'claimed' || job.leaseExpiresAt! > d.now()) return { ok: false, error: 'invalid_state' }
    tx.set({ ...job, state: run.cancelRequestedAt !== undefined ? 'cancelled' : 'failed', endedAt: d.now(), failure: 'worker_confirmed_stopped', recoveredBy: actor.uid })
    return { ok: true, value: run }
  })
}

/**
 * Reconcile a terminal workflow with its active queue attempt so the run can be
 * recovered safely.
 */
export async function recordQueueWorkflowFailure(d: JobsDeps, id: string, number: number, workflowId: string, status: 'failed' | 'cancelled' | 'completed'): Promise<boolean> {
  if (!localQueueEnabled(d)) return false
  let imageVerification: ReturnType<typeof verifiedImageFields> | undefined
  return d.store.transaction(async tx => {
    const run = await scopedRun(tx, id, d.localScope)
    const attempt = run?.attempts.at(-1)
    if (!run || !attempt || attempt.number !== number || attempt.workflowId !== workflowId || !['queued', 'running'].includes(run.status)) return false
    const currentId = attempt.jobIds.at(-1)
    const current = currentId ? await tx.get(currentId) : null
    const reason = status === 'completed' ? 'workflow_ended_early' : `workflow_${status}`
    if (current?.state === 'claimed') {
      if (run.waitReason === 'recovery' && attempt.error === reason) return false
      run.status = 'running'; run.waitReason = 'recovery'; run.updatedAt = d.now(); attempt.error = reason
      tx.set({ ...current, recoveryNeededAt: current.recoveryNeededAt ?? d.now() })
    } else {
      if (current?.state === 'queued') tx.set({ ...current, state: 'failed', endedAt: d.now(), failure: reason })
      if (run.incrementalDrafts && !run.previewOnly && current?.state === 'completed' && current.queueRunId === run.id &&
        current.queueAttempt === number && current.queueStep === attempt.cursor && current.batchId === run.batchId &&
        current.localScope === d.localScope && current.requestedBy === run.requestedBy && current.plateId === attempt.steps[attempt.cursor]?.plateId) {
        await settleQueueStage(d, tx, run, attempt, current, candidate => imageVerification ??= verifiedImageFields(candidate))
      }
      if (['queued', 'running'].includes(run.status)) finishRun(run, run.cancelRequestedAt !== undefined || status === 'cancelled' ? 'cancelled' : 'failed', d.now(), reason)
    }
    tx.setRun(run)
    return true
  })
}
