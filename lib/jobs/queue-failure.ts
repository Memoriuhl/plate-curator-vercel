import { localQueueEnabled } from './queue'
import type { JobsDeps, Outcome, TaggingJob } from './types'

const reasons = new Set(['no_handler', 'stage_failed', 'missing_image', 'lease_expired', 'stale_input', 'report_failed'])

export async function failLocalJob(d: JobsDeps, workerId: string, id: string, claimId: string, reason: string): Promise<Outcome<TaggingJob>> {
  if (!localQueueEnabled(d)) return { ok: false, error: 'forbidden' }
  return d.store.transaction(async tx => {
    const job = await tx.get(id)
    if (!job) return { ok: false, error: 'not_found' }
    if (job.localScope !== d.localScope) return { ok: false, error: 'forbidden' }
    if (job.claimId !== claimId || job.workerId !== workerId) return { ok: false, error: 'claim_mismatch' }
    if (['completed', 'failed', 'cancelled'].includes(job.state)) return { ok: true, value: job }
    if (job.state !== 'claimed') return { ok: false, error: 'claim_mismatch' }
    const run = job.queueRunId ? (await tx.runs()).find(run => run.id === job.queueRunId) : undefined
    const failed: TaggingJob = { ...job, state: run?.cancelRequestedAt !== undefined ? 'cancelled' : 'failed', endedAt: d.now(), failure: reasons.has(reason) ? reason : 'stage_failed' }
    tx.set(failed)
    return { ok: true, value: failed }
  })
}
