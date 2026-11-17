import type { Actor, Outcome as ReviewOutcome } from '../review/types'
import { plateRevision } from '../review/revision'
import type { JobsDeps, JobsTransaction, Outcome, ReportInput, JobResult, TaggingJob } from './types'

async function currentPlate(d: JobsDeps, tx: JobsTransaction, batchId: string, plateId: string) {
  const review = await tx.review(batchId, plateId)
  const baseline = review && d.baselineAtVersion ? await d.baselineAtVersion(review.baselineVersion, plateId) : await d.baseline(plateId)
  return review && baseline ? { ...baseline, ...review.fields } : null
}

export async function createJob(d: JobsDeps, input: { id: string; batchId: string; plateId: string; requestedBy: string; route?: 'hosted'; modelId?: string }): Promise<Outcome<TaggingJob>> {
  return d.store.transaction(async tx => {
    if (await tx.get(input.id)) return { ok: false, error: 'already_exists' }
    const inputPlate = await currentPlate(d, tx, input.batchId, input.plateId)
    if (!inputPlate) return { ok: false, error: 'not_found' }
    const job: TaggingJob = { ...input, inputPlate, inputHash: plateRevision(inputPlate), env: d.store.env, createdAt: d.now(), state: 'queued' }
    tx.create(job)
    return { ok: true, value: job }
  })
}

export async function claimNext(d: JobsDeps, workerId: string) {
  if (!Number.isFinite(d.leaseMs) || d.leaseMs <= 0) throw new Error('Lease must be positive and finite')
  const claimId = d.id()
  return d.store.transaction(async tx => {
    const now = d.now()
    const jobs = await tx.list()
    const job = jobs.filter(job => job.route !== 'hosted' && claimable(job, now))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]
    if (!job) return null
    const leaseExpiresAt = now + d.leaseMs
    const claimed: TaggingJob = { ...job, state: 'claimed', workerId, claimId, leaseExpiresAt }
    tx.set(claimed)
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
    if (job.state === 'expired') return { ok: false, error: 'claim_expired' }
    if (job.state === 'completed') return { ok: true, value: { job, claimId: job.claimId! } }
    if (!claimable(job, d.now()) && job.workerId !== workerId) return { ok: false, error: 'claim_mismatch' }
    const claimed: TaggingJob = { ...job, state: 'claimed', workerId, claimId, leaseExpiresAt: d.now() + d.leaseMs }
    tx.set(claimed)
    return { ok: true, value: { job: claimed, claimId } }
  })
}

function normalize(input: ReportInput): JobResult | null {
  if (!input || !Array.isArray(input.suggestions) || !['backend', 'model', 'promptVersion'].every(key => {
    const value = input[key as keyof ReportInput]
    return typeof value === 'string' && value.trim().length > 0
  }) || !Number.isFinite(input.durationMs) || input.durationMs < 0) return null
  if (input.usage !== undefined && (!input.usage || typeof input.usage !== 'object' || Array.isArray(input.usage) ||
    Object.values(input.usage).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0))) return null
  const suggestions = [...new Set(input.suggestions.filter((value): value is string => typeof value === 'string')
    .map(value => value.trim().toLowerCase()).filter(value => value.length > 0 && value.length <= 60))].slice(0, 20)
  return { suggestions, backend: input.backend, model: input.model, promptVersion: input.promptVersion, durationMs: input.durationMs,
    ...(input.usage === undefined ? {} : { usage: Object.fromEntries(Object.entries(input.usage).sort(([a], [b]) => a.localeCompare(b))) }) }
}

export async function reportResult(d: JobsDeps, workerId: string, id: string, claimId: string, input: ReportInput): Promise<Outcome<TaggingJob>> {
  return d.store.transaction(async tx => {
    const job = await tx.get(id)
    if (!job) return { ok: false, error: 'not_found' }
    if (!job.claimId || job.claimId !== claimId || job.workerId !== workerId) return { ok: false, error: 'claim_mismatch' }
    if (job.state === 'expired') return { ok: false, error: 'claim_expired' }
    if (job.state !== 'completed' && job.leaseExpiresAt! <= d.now()) return { ok: false, error: 'claim_expired' }
    const result = normalize(input)
    if (!result) return { ok: false, error: 'invalid_result' }
    if (job.state === 'completed') return JSON.stringify(job.result) === JSON.stringify(result)
      ? { ok: true, value: job } : { ok: false, error: 'result_mismatch' }
    const current = await currentPlate(d, tx, job.batchId, job.plateId)
    if (!current || plateRevision(current) !== job.inputHash) return { ok: false, error: 'stale_input' }
    const completed: TaggingJob = { ...job, state: 'completed', result, completedAt: d.now() }
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
    if (job.state === 'completed' || job.state === 'expired') return { ok: true, value: job }
    const expired: TaggingJob = { ...job, state: 'expired', expiredAt: d.now() }
    tx.set(expired)
    return { ok: true, value: expired }
  })
}
