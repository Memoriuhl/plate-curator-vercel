import { defaultImageEnhancement, enhancementOperations } from './image-enhancement'
import type { Actor, Outcome as ReviewOutcome } from '../review/types'
import { sortedJsonValue } from '../review/canonical-value'
import { plateRevision } from '../review/revision'
import type { JobsDeps, JobsTransaction, Outcome, ReportInput, JobResult, TaggingJob, PipelineStage } from './types'
import { isPipelineStage, parseFieldSuggestion } from './suggestions'
import type { ImageGroupOptions } from './image-options'
import type { GroupInput } from './specialized-suggestions'
import { completeGroupScope, validGroupContext } from '../review/group-context'
import { localClaimCandidate, localClaimsEnabled, type LocalClaimFeatures } from './queue-claim'
import { currentProjectionMatches, queueStageTimeoutMs, queueGroupContext } from './queue'
import { filterEnrichmentFields } from '../research/enrichment'
import { workflowVisibilityUrl } from './workflow-visibility'

// Server coordinator only. The public worker by-id claim still refuses queue jobs.
export async function claimHostedQueueJob(d: JobsDeps, id: string) {
  return d.store.transaction(async tx => {
    const jobs = await tx.list()
    const runs = await tx.runs()
    const job = jobs.find(job => job.id === id && job.localScope === d.localScope && job.route === 'hosted' && job.queueRunId)
    if (!job) return null
    // Workflow retries retain the same reservation; never hand it to a desktop worker.
    if (job.state === 'claimed' && job.workerId === 'hosted' && job.leaseExpiresAt! > d.now()) return { job, claimId: job.claimId! }
    if (localClaimCandidate(d, jobs, runs, 'hosted')?.id !== id) return null
    const now = d.now()
    const claimed: TaggingJob = { ...job, state: 'claimed', startedAt: now, workerId: 'hosted', claimId: d.id(), leaseExpiresAt: now + queueStageTimeoutMs }
    const run = runs.find(run => run.id === job.queueRunId)!
    run.lastDispatchedAt = Math.max(d.now(), ...runs.map(run => (run.lastDispatchedAt ?? 0) + 1)); run.status = 'running'; run.waitReason = 'inference'; run.updatedAt = d.now()
    tx.set(claimed); tx.setRun(run)
    return { job: claimed, claimId: claimed.claimId! }
  })
}

async function currentPlate(d: JobsDeps, tx: JobsTransaction, batchId: string, plateId: string) {
  const review = await tx.review(batchId, plateId)
  const baseline = review && d.baselineAtVersion ? await d.baselineAtVersion(review.baselineVersion, plateId) : await d.baseline(plateId)
  return review && baseline ? { ...baseline, ...review.fields } : null
}

export async function createJob(d: JobsDeps, input: { id: string; batchId: string; plateId: string; requestedBy: string; route?: 'hosted'; workflowId?: string; modelId?: string; stage?: PipelineStage; groupScope?: GroupInput; stageOptions?: ImageGroupOptions }): Promise<Outcome<TaggingJob> | { ok: false; error: 'publish_in_progress' }> {
  if (input.stage === 'research') return { ok: false, error: 'forbidden' } // Research requires the persisted queue model/policy contract.
  if (input.stage !== undefined && (process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1' || !d.localScope || !isPipelineStage(input.stage))) return { ok: false, error: 'forbidden' }
  if (input.stageOptions && (!input.stage || input.stageOptions.method && input.stageOptions.method !== 'embeddings')) return { ok: false, error: 'forbidden' }
  if (input.groupScope && input.stage !== 'group' || input.stage === 'group' && (!input.groupScope?.length || input.groupScope.length > 25 || new Set(input.groupScope.map(member => member.plate.id)).size !== input.groupScope.length || !input.groupScope.some(member => member.plate.id === input.plateId) || new Set(input.groupScope.map(member => member.plate.state)).size !== 1)) return { ok: false, error: 'forbidden' }
  return d.store.transaction(async tx => {
    if (await tx.get(input.id)) return { ok: false, error: 'already_exists' }
    if (await tx.canQueue?.() === false) return { ok: false, error: 'publish_in_progress' }
    const inputPlate = await currentPlate(d, tx, input.batchId, input.plateId)
    if (!inputPlate) return { ok: false, error: 'not_found' }
    let groupScope: GroupInput | undefined
    let standardId: string | undefined
    if (input.stage === 'group') {
      const batch = await tx.batch(input.batchId)
      if (!batch || batch.state !== 'open' || !d.stateBaseline || input.groupScope!.some(member => !batch.plateIds.includes(member.plate.id))) return { ok: false, error: 'forbidden' }
      const statePlates = []
      for (const baseline of await d.stateBaseline(batch.baselineVersion, inputPlate.state)) {
        statePlates.push(batch.plateIds.includes(baseline.id) ? await currentPlate(d, tx, input.batchId, baseline.id) ?? baseline : baseline)
      }
      groupScope = []
      for (const member of input.groupScope!) {
        const plate = statePlates.find(plate => plate.id === member.plate.id)
        if (!plate || plateRevision(plate) !== member.baseRevision) return { ok: false, error: 'stale_input' }
        groupScope.push({ plate, baseRevision: plateRevision(plate) })
      }
      if (!completeGroupScope(groupScope.map(member => member.plate), statePlates)) return { ok: false, error: 'forbidden' }
      standardId = batch.stateOrders[inputPlate.state]?.[0] ?? statePlates.find(plate => plate.isStandard)?.id ?? statePlates[0]?.id
    }
    for (const member of input.groupScope ?? []) {
      const current = await currentPlate(d, tx, input.batchId, member.plate.id)
      if (!current || plateRevision(current) !== member.baseRevision) return { ok: false, error: 'stale_input' }
    }
    const job: TaggingJob = { ...input, ...(input.workflowId ? { workflowUrl: workflowVisibilityUrl(input.workflowId, process.env.VERCEL_ENV, process.env.WORKFLOW_TARGET_WORLD) } : {}), ...(groupScope ? { groupScope, standardId } : {}), ...(d.localScope ? { localScope: d.localScope } : {}), inputPlate, inputHash: plateRevision(inputPlate), env: d.store.env, createdAt: d.now(), state: 'queued' }
    tx.create(job)
    return { ok: true, value: job }
  })
}

export async function claimNext(d: JobsDeps, workerId: string, features: LocalClaimFeatures = {}) {
  if (!Number.isFinite(d.leaseMs) || d.leaseMs <= 0) throw new Error('Lease must be positive and finite')
  const claimId = d.id()
  return d.store.transaction(async tx => {
    const now = d.now()
    const jobs = await tx.list()
    const local = localClaimsEnabled(d)
    const runs = local ? await tx.runs() : []
    const job = local ? localClaimCandidate(d, jobs, runs, 'local', features) : jobs.filter(job => !job.queueRunId && job.localScope === d.localScope && job.route !== 'hosted' && claimable(job, now))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]
    if (!job) return null
    const leaseExpiresAt = now + (job.queueRunId ? queueStageTimeoutMs : d.leaseMs)
    const claimed: TaggingJob = { ...job, state: 'claimed', startedAt: now, workerId, claimId, leaseExpiresAt }
    tx.set(claimed)
    if (job.queueRunId) {
      const run = runs.find(run => run.id === job.queueRunId)!
      const step = run.attempts.at(-1)?.steps[job.queueStep!]
      if (step) Object.assign(step, { status: 'running', startedAt: now })
      run.lastDispatchedAt = Math.max(now, ...runs.map(run => (run.lastDispatchedAt ?? 0) + 1)); run.status = 'running'; run.updatedAt = now; run.waitReason = 'resource'
      tx.setRun(run)
    }
    return { job: claimed, claimId, leaseExpiresAt }
  })
}

function claimable(job: TaggingJob, now: number) {
  return job.state === 'queued' || (job.state === 'claimed' && job.leaseExpiresAt! <= now)
}

export async function claimJob(d: JobsDeps, workerId: string, id: string): Promise<Outcome<{ job: TaggingJob; claimId: string }>> {
  if (!Number.isFinite(d.leaseMs) || d.leaseMs <= 0) throw new Error('Lease must be positive and finite')
  const claimId = d.id()
  return d.store.transaction(async tx => {
    const job = await tx.get(id)
    if (!job) return { ok: false, error: 'not_found' }
    if (job.localScope !== d.localScope) return { ok: false, error: 'forbidden' }
    if (job.queueRunId) return { ok: false, error: 'forbidden' }
    if (job.state === 'expired') return { ok: false, error: 'claim_expired' }
    if (job.state === 'completed') return { ok: true, value: { job, claimId: job.claimId! } }
    if (localClaimsEnabled(d) && job.route !== 'hosted' && job.state !== 'queued') return { ok: false, error: 'claim_mismatch' }
    if (localClaimsEnabled(d) && job.route !== 'hosted' && localClaimCandidate(d, await tx.list(), await tx.runs())?.id !== job.id) return { ok: false, error: 'claim_mismatch' }
    if (!claimable(job, d.now()) && job.workerId !== workerId) return { ok: false, error: 'claim_mismatch' }
    const claimed: TaggingJob = { ...job, state: 'claimed', startedAt: d.now(), workerId, claimId, leaseExpiresAt: d.now() + d.leaseMs }
    tx.set(claimed)
    return { ok: true, value: { job: claimed, claimId } }
  })
}

function normalize(input: ReportInput, stage?: PipelineStage): JobResult | null {
  const stageError = stage && process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' && (input?.stageError === 'no_sources' || input?.stageError === 'no_supported_fields' || input?.stageError === 'unavailable' || input?.stageError === 'missing_image') ? input.stageError : undefined
  if (input?.stageError !== undefined && !stageError) return null
  const fieldSuggestion = stage && !stageError ? parseFieldSuggestion(input?.fieldSuggestion, stage) : undefined
  if (stage && (!stageError && !fieldSuggestion || stageError && input.fieldSuggestion !== undefined || input.suggestions !== undefined && (!Array.isArray(input.suggestions) || input.suggestions.length > 0))) return null
  if (!stage && (input?.fieldSuggestion !== undefined || input?.stageError !== undefined)) return null
  const rawTags = stage ? [] : input?.suggestions
  if (!input || !Array.isArray(rawTags) || !['backend', 'model', 'promptVersion'].every(key => {
    const value = input[key as keyof ReportInput]
    return typeof value === 'string' && value.trim().length > 0
  }) || !Number.isFinite(input.durationMs) || input.durationMs < 0) return null
  if (input.usage !== undefined && (!input.usage || typeof input.usage !== 'object' || Array.isArray(input.usage) ||
    Object.values(input.usage).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0))) return null
  const suggestions = [...new Set(rawTags.filter((value): value is string => typeof value === 'string')
    .map(value => value.trim().toLowerCase()).filter(value => value.length > 0 && value.length <= 60))].slice(0, 20)
  return { suggestions, ...(fieldSuggestion ? { fieldSuggestion } : {}), ...(stageError ? { stageError } : {}), backend: input.backend, model: input.model, promptVersion: input.promptVersion, durationMs: input.durationMs,
    ...(input.usage === undefined ? {} : { usage: Object.fromEntries(Object.entries(input.usage).sort(([a], [b]) => a.localeCompare(b))) }) }
}

export async function reportResult(d: JobsDeps, workerId: string, id: string, claimId: string, input: ReportInput): Promise<Outcome<TaggingJob>> {
  return d.store.transaction(async tx => {
    const job = await tx.get(id)
    if (!job) return { ok: false, error: 'not_found' }
    if (job.localScope !== d.localScope) return { ok: false, error: 'forbidden' }
    if (!job.claimId || job.claimId !== claimId || job.workerId !== workerId) return { ok: false, error: 'claim_mismatch' }
    if (job.state === 'expired') return { ok: false, error: 'claim_expired' }
    if (job.state === 'failed' || job.state === 'cancelled') return { ok: false, error: 'claim_expired' }
    if (job.state !== 'completed' && job.leaseExpiresAt! <= d.now()) return { ok: false, error: 'claim_expired' }
    const result = normalize(input, job.stage)
    if (!result) return { ok: false, error: 'invalid_result' }
    const enhancement = result.fieldSuggestion?.kind === 'enhanced-image' ? result.fieldSuggestion : null
    const attachment = input.enhancedImage !== undefined || input.enhancedImageFrames !== undefined
    if ((enhancement && (!job.queueRunId || !localClaimsEnabled(d))) || (!enhancement && attachment)) {
      return { ok: false, error: 'invalid_result' }
    }
    let imageBytes: Buffer | null = null
    const previews = new Map<string, Buffer>()
    if (enhancement) {
      const { verifyEnhancedImage } = await import('./verify-enhanced-image')
      imageBytes = await verifyEnhancedImage(input.enhancedImage, enhancement)
      if (!imageBytes) return { ok: false, error: 'invalid_result' }
      const { frames } = enhancement
      const frameInput = input.enhancedImageFrames
      if (!frames && frameInput !== undefined) return { ok: false, error: 'invalid_result' }
      if (frames) {
        const options = { ...defaultImageEnhancement, ...job.stageOptions }
        const expected = ['original', ...enhancementOperations.filter(step => options[step])]
        if (!Array.isArray(frameInput) || frameInput.length !== frames.length - 1 || expected.length !== frames.length ||
          frames.some(({ step }, index) => expected[index] !== step)) return { ok: false, error: 'invalid_result' }
        for (const [index, frame] of frames.slice(0, -1).entries()) {
          const bytes = await verifyEnhancedImage(frameInput[index], frame)
          if (!bytes) return { ok: false, error: 'invalid_result' }
          previews.set(frame.step, bytes)
        }
      }
    }
    if (job.stage === 'research') {
      if (!job.researchModel || result.model !== job.researchModel.model) return { ok: false, error: 'invalid_result' }
      if (result.fieldSuggestion?.kind === 'fields') {
        result.fieldSuggestion.fields = filterEnrichmentFields(result.fieldSuggestion.fields, job.inputPlate!, job.researchPolicy ?? 'fill-missing')
        if (!Object.keys(result.fieldSuggestion.fields).length) { delete result.fieldSuggestion; result.stageError = 'no_supported_fields' }
      }
    }
    if (job.state === 'completed') return JSON.stringify(sortedJsonValue(job.result)) === JSON.stringify(sortedJsonValue(result))
      ? { ok: true, value: job } : { ok: false, error: 'result_mismatch' }
    if (result.fieldSuggestion?.kind === 'group') {
      const expected = job.groupScope?.map(member => ({ plateId: member.plate.id, baseRevision: member.baseRevision })).sort((a, b) => a.plateId.localeCompare(b.plateId))
      if (JSON.stringify(expected) !== JSON.stringify(result.fieldSuggestion.scope)) return { ok: false, error: 'invalid_result' }
      for (const member of job.groupScope ?? []) {
        const current = await currentPlate(d, tx, job.batchId, member.plate.id)
        if (!current || plateRevision(current) !== member.baseRevision) return { ok: false, error: 'stale_input' }
      }
    }
    let checksDraftAtApply = false
    if (job.queueRunId) {
      const run = await tx.getRun(job.queueRunId)
      const attempt = run?.attempts.at(-1)
      const projected = attempt?.projection?.plates[job.plateId]
      if (!run || run.localScope !== d.localScope || !attempt || run.batchId !== job.batchId || run.requestedBy !== job.requestedBy ||
        attempt.number !== job.queueAttempt || attempt.cursor !== job.queueStep || !projected ||
        job.inputHash !== projected.batchInputHash || job.executionHash !== projected.executionHash || !job.inputPlate ||
        plateRevision(job.inputPlate) !== projected.executionHash) return { ok: false, error: 'stale_input' }
      checksDraftAtApply = Boolean(run.incrementalDrafts && !run.previewOnly && job.stage !== 'group')
      if (job.stage === 'group') {
        const entries = Object.values(attempt.projection!.plates)
        if (!job.groupScope || job.groupScope.length !== entries.length || new Set(job.groupScope.map(member => member.plate.id)).size !== entries.length ||
          job.groupScope.some(member => {
            const expected = attempt.projection!.plates[member.plate.id]
            return !expected || member.baseRevision !== expected.batchInputHash || plateRevision(member.plate) !== expected.executionHash
          })) return { ok: false, error: 'invalid_result' }
        const batch = await tx.batch(job.batchId)
        if (!batch || !await currentProjectionMatches(d, tx, run, batch)) return { ok: false, error: 'stale_input' }
        const context = await queueGroupContext(d, tx, batch, entries.map(entry => entry.batchInput))
        if (!context || job.standardId !== context.standardId || result.fieldSuggestion?.kind === 'group' &&
          !validGroupContext(result.fieldSuggestion, entries.map(entry => entry.executionPlate), context.statePlates, context.standardId)) return { ok: false, error: 'invalid_result' }
      }
    }
    if (!checksDraftAtApply) {
      const current = await currentPlate(d, tx, job.batchId, job.plateId)
      if (!current || plateRevision(current) !== job.inputHash) return { ok: false, error: 'stale_input' }
    }
    const completed: TaggingJob = { ...job, state: 'completed', result, completedAt: d.now() }
    if (imageBytes) tx.setEnhancedImage(id, imageBytes)
    for (const [step, bytes] of previews) tx.setEnhancedImage(`${id}--${step}`, bytes)
    tx.set(completed)
    return { ok: true, value: completed }
  })
}

export function getJob(d: JobsDeps, id: string) {
  return d.store.transaction(tx => tx.get(id))
}

export async function getJobForActor(d: JobsDeps, actor: Actor, id: string): Promise<ReviewOutcome<TaggingJob>> {
  const job = await getJob(d, id)
  if (!job || (job.requestedBy !== actor.uid && actor.role !== 'owner')) return { ok: false, error: 'not_found' }
  return { ok: true, value: job }
}

export async function expireJob(d: JobsDeps, id: string): Promise<Outcome<TaggingJob>> {
  return d.store.transaction(async tx => {
    const job = await tx.get(id)
    if (!job) return { ok: false, error: 'not_found' }
    if (d.localScope && job.localScope !== d.localScope) return { ok: false, error: 'forbidden' }
    if (job.state === 'completed' || job.state === 'expired') return { ok: true, value: job }
    if (localClaimsEnabled(d) && job.localScope === d.localScope && job.route !== 'hosted' && job.state === 'claimed') {
      const pending = { ...job, recoveryNeededAt: job.recoveryNeededAt ?? d.now() }
      tx.set(pending)
      return { ok: true, value: pending }
    }
    if (localClaimsEnabled(d) && (job.state === 'failed' || job.state === 'cancelled')) return { ok: true, value: job }
    const expired: TaggingJob = { ...job, state: 'expired', expiredAt: d.now() }
    tx.set(expired)
    return { ok: true, value: expired }
  })
}
