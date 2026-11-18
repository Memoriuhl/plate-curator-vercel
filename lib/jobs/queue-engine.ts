import { currentProjectionMatches, finishRun, localQueueEnabled, queuePermission, queueRecordFits, queueGroupContext } from './queue'
import { plateRevision } from '../review/revision'
import { projectJob, type ProjectedPlate } from './queue-projection'
import type { Actor } from '../review/types'
import { canEdit } from '../review/access'
import type { JobsDeps, TaggingJob } from './types'
import type { PipelineRun, QueueOutcome, RunAttempt } from './queue-types'
import { pipelineNeedsModel, type RunStep } from './pipeline-plan'
import { storyUrl } from '../review/fields'
import { workflowVisibilityUrl } from './workflow-visibility'

export type StageObservation = { phase: 'done' | 'next' | 'waiting' | 'claimed'; deadline?: number }

function advanceStage(run: PipelineRun, attempt: RunAttempt, jobId: string, now: number) {
  attempt.completedJobIds.push(jobId)
  Object.assign(attempt.steps[attempt.cursor], { status: 'completed', endedAt: now })
  attempt.cursor++
  delete attempt.error
  if (attempt.cursor === attempt.steps.length) {
    if (attempt.noResultCount) attempt.outcome = attempt.noResultCount === attempt.cursor ? 'no_result' : 'partial'
    finishRun(run, 'completed', now)
    return
  }
  run.updatedAt = now
  run.waitReason = 'worker'
  run.status = 'queued'
}

function missingResearchInput(attempt: RunAttempt, step: RunStep, plate: ProjectedPlate): string | undefined {
  if (step.stage !== 'describe' && step.stage !== 'story') return
  const preceding = (stage: 'wiki-link' | 'describe') => attempt.steps.find(candidate =>
    candidate.index < step.index && candidate.plateId === step.plateId && candidate.stage === stage)
  const wiki = preceding('wiki-link')
  if (wiki && (!storyUrl(plate.executionPlate.wikiUrl) || !plate.sourceJobIds.includes(attempt.completedJobIds[wiki.index]))) return 'missing_wiki_link'
  if (step.stage === 'story') {
    const describe = preceding('describe')
    if (describe && (!plate.executionPlate.description?.trim() || !plate.sourceJobIds.includes(attempt.completedJobIds[describe.index]))) return 'missing_description'
  }
}

export async function bindQueueWorkflow(d: JobsDeps, id: string, number: number, workflowId: string): Promise<boolean> {
  if (!localQueueEnabled(d)) return false
  return d.store.transaction(async tx => {
    const run = (await tx.runs()).find(run => run.id === id && run.localScope === d.localScope)
    const attempt = run?.attempts.at(-1)
    if (!run || !attempt || attempt.number !== number || !['queued', 'running'].includes(run.status) || attempt.workflowId && attempt.workflowId !== workflowId) return false
    attempt.workflowId = workflowId
    attempt.workflowUrl = workflowVisibilityUrl(workflowId, process.env.VERCEL_ENV)
    run.updatedAt = d.now(); tx.setRun(run)
    return true
  })
}

export async function dispatchQueueStage(d: JobsDeps, id: string, number: number, index: number, completionHook: string): Promise<string | null> {
  if (!localQueueEnabled(d)) return null
  return d.store.transaction(async tx => {
    const run = (await tx.runs()).find(run => run.id === id && run.localScope === d.localScope)
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
    else if (!projected || !await currentProjectionMatches(d, tx, run, batch)) error = 'stale_input'
    else error = missingResearchInput(attempt, step, projected)
    const groupContext = step.stage === 'group' && batch ? await queueGroupContext(d, tx, batch, Object.values(attempt.projection!.plates).map(entry => entry.batchInput)) : null
    if (step.stage === 'group' && !groupContext) error = 'invalid_group_scope'
    if (run.cancelRequestedAt !== undefined || error || !projected) {
      finishRun(run, run.cancelRequestedAt !== undefined ? 'cancelled' : 'failed', d.now(), error)
      tx.setRun(run); return null
    }
    const job: TaggingJob = { id: jobId, batchId: run.batchId, plateId: step.plateId, requestedBy: run.requestedBy, enqueuedBy: run.requestedBy,
      env: d.store.env, localScope: d.localScope!, queueRunId: id, previewOnly: run.previewOnly, queueAttempt: number, queueStep: index, resourceClass: step.resourceClass,
      queueOrder: run.enqueueSequence,
      createdAt: d.now(), state: 'queued', inputPlate: projected.executionPlate, inputHash: projected.batchInputHash, executionHash: projected.executionHash,
      completionHook, ...(step.stage === 'tag' ? {} : { stage: step.stage }), ...(run.modelId && pipelineNeedsModel([step], run.options) ? { modelId: run.modelId } : {}),
      ...(run.options[step.stage as keyof typeof run.options] ? { stageOptions: run.options[step.stage as keyof typeof run.options] } : {}),
      ...(step.stage === 'group' ? { groupScope: Object.values(attempt.projection!.plates).map(entry => ({ plate: entry.executionPlate, baseRevision: entry.batchInputHash })), ...(groupContext?.standardId ? { standardId: groupContext.standardId } : {}) } : {}),
    }
    attempt.jobIds.push(jobId); attempt.status = 'running'; run.waitReason = 'worker'; run.updatedAt = d.now()
    if (!queueRecordFits(run)) { finishRun(run, 'failed', d.now(), 'payload_too_large'); tx.setRun(run); return null }
    tx.create(job); tx.setRun(run)
    return jobId
  })
}

export async function observeQueueStage(d: JobsDeps, id: string, number: number, index: number): Promise<StageObservation> {
  if (!localQueueEnabled(d)) return { phase: 'done' }
  return d.store.transaction(async tx => {
    const run = (await tx.runs()).find(run => run.id === id && run.localScope === d.localScope)
    const attempt = run?.attempts.at(-1)
    if (!run || !attempt || attempt.number !== number || !['queued', 'running'].includes(run.status)) return { phase: 'done' }
    if (attempt.cursor > index) return { phase: 'next' }
    const job = await tx.get(`${id}-${number}-${index}`)
    if (!job) { finishRun(run, 'failed', d.now(), 'job_missing'); tx.setRun(run); return { phase: 'done' } }
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
    let error = job.failure
    if (run.cancelRequestedAt !== undefined) finishRun(run, 'cancelled', d.now())
    else if (job.state !== 'completed') finishRun(run, 'failed', d.now(), error ?? 'stage_failed')
    else if (job.result?.stageError) {
      if (job.result.stageError === 'no_sources' || job.result.stageError === 'no_supported_fields') attempt.outcome = 'no_result'
      finishRun(run, 'failed', d.now(), job.result.stageError)
    } else {
      const raw = job.result?.fieldSuggestion
      const candidateId = attempt.choices[job.id]
      if (raw?.kind === 'image' && !candidateId) {
        if (run.waitReason !== 'image_choice') { run.status = 'running'; run.waitReason = 'image_choice'; run.updatedAt = d.now(); tx.setRun(run) }
        return { phase: 'waiting' }
      }
      const original = attempt.projection!
      let projected = projectJob(original, job)
      if (raw?.kind === 'image' && candidateId) {
        const candidate = raw.candidates?.find(candidate => candidate.id === candidateId)
        const entry = original.plates[job.plateId]
        if (candidate && entry.batchInputHash === job.inputHash && entry.executionHash === job.executionHash) {
          const executionPlate = { ...entry.executionPlate, imageUrl: candidate.imageUrl, sourceUrl: candidate.sourceUrl }
          projected = { ok: true, value: { ...original, plates: { ...original.plates, [job.plateId]: { ...entry, executionPlate,
            executionHash: plateRevision(executionPlate), sourceJobIds: [...entry.sourceJobIds, job.id] } } } }
        }
      }
      if (!projected.ok) error = projected.error
      else {
        attempt.projection = projected.value
        if (!queueRecordFits(run)) { attempt.projection = original; error = 'payload_too_large' }
        else advanceStage(run, attempt, job.id, d.now())
      }
      if (error) finishRun(run, 'failed', d.now(), error)
    }
    tx.setRun(run)
    return { phase: run.status === 'queued' ? 'next' : 'done' }
  })
}

export async function chooseQueueImage(d: JobsDeps, actor: Actor, id: string, jobId: string, candidateId: string): Promise<QueueOutcome<PipelineRun>> {
  if (!localQueueEnabled(d)) return { ok: false, error: 'forbidden' }
  return d.store.transaction(async tx => {
    const run = (await tx.runs()).find(run => run.id === id && run.localScope === d.localScope)
    if (!run) return { ok: false, error: 'not_found' }
    const batch = await tx.batch(run.batchId)
    const error = queuePermission(batch, actor)
    if (error) return { ok: false, error }
    const job = await tx.get(jobId)
    const attempt = run.attempts.at(-1)!
    const raw = job?.result?.fieldSuggestion
    if (!job || job.queueRunId !== run.id || job.queueAttempt !== attempt.number || job.queueStep !== attempt.cursor || job.state !== 'completed' ||
      raw?.kind !== 'image' || !raw.candidates?.some(candidate => candidate.id === candidateId) || run.cancelRequestedAt !== undefined) return { ok: false, error: 'invalid_state' }
    if (!await currentProjectionMatches(d, tx, run, batch!)) return { ok: false, error: 'stale_input' }
    if (attempt.choices[job.id] && attempt.choices[job.id] !== candidateId) return { ok: false, error: 'invalid_state' }
    attempt.choices[job.id] = candidateId; run.updatedAt = d.now(); tx.setRun(run)
    return { ok: true, value: run }
  })
}

export async function confirmStoppedWorker(d: JobsDeps, actor: Actor, id: string, jobId: string, claimId: string): Promise<QueueOutcome<PipelineRun>> {
  if (!localQueueEnabled(d)) return { ok: false, error: 'forbidden' }
  return d.store.transaction(async tx => {
    const run = (await tx.runs()).find(run => run.id === id && run.localScope === d.localScope)
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

export async function recordQueueWorkflowFailure(d: JobsDeps, id: string, number: number, workflowId: string, status: 'failed' | 'cancelled' | 'completed'): Promise<boolean> {
  if (!localQueueEnabled(d)) return false
  return d.store.transaction(async tx => {
    const run = (await tx.runs()).find(run => run.id === id && run.localScope === d.localScope)
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
      finishRun(run, run.cancelRequestedAt !== undefined ? 'cancelled' : 'failed', d.now(), reason)
    }
    tx.setRun(run)
    return true
  })
}
