import { localQueueEnabled } from './queue'
import type { JobsDeps, Outcome, TaggingJob } from './types'
import { canEdit } from '../review/access'
import type { Actor } from '../review/types'
import { STRICT_MODEL_FAILURE } from '../models/routing'

const reasons = new Set([
  'no_handler',
  'stage_failed',
  'research_budget_exhausted',
  STRICT_MODEL_FAILURE,
  'missing_image',
  'lease_expired',
  'stale_input',
  'report_failed',
])

/** Record a local worker failure only while its claim still owns the job. */
export async function failLocalJob(
  d: JobsDeps,
  workerId: string,
  id: string,
  claimId: string,
  reason: string
): Promise<Outcome<TaggingJob>> {
  if (!localQueueEnabled(d)) return { ok: false, error: 'forbidden' }
  return d.store.transaction(async (tx) => {
    const job = await tx.get(id)
    if (!job) return { ok: false, error: 'not_found' }
    if (job.localScope !== d.localScope)
      return { ok: false, error: 'forbidden' }
    if (job.claimId !== claimId || job.workerId !== workerId)
      return { ok: false, error: 'claim_mismatch' }
    if (['completed', 'failed', 'cancelled'].includes(job.state))
      return { ok: true, value: job }
    if (job.state !== 'claimed') return { ok: false, error: 'claim_mismatch' }
    const run = job.queueRunId
      ? (await tx.runs()).find((run) => run.id === job.queueRunId)
      : undefined
    const failed: TaggingJob = {
      ...job,
      state: run?.cancelRequestedAt !== undefined ? 'cancelled' : 'failed',
      endedAt: d.now(),
      failure: reasons.has(reason) ? reason : 'stage_failed',
    }
    tx.set(failed)
    return { ok: true, value: failed }
  })
}

/**
 * Find stranded local jobs in the current scope and reconcile expired claims for the
 * recovery view.
 */
export async function listLocalOrphanJobs(
  d: JobsDeps,
  actor: Actor
): Promise<TaggingJob[]> {
  if (!localQueueEnabled(d)) return []
  return d.store.transaction(async (tx) => {
    const candidates = (await tx.list()).filter(
      (job) =>
        job.localScope === d.localScope &&
        !job.queueRunId &&
        job.route !== 'hosted' &&
        job.state === 'claimed' &&
        (job.requestedBy === actor.uid || actor.role === 'owner')
    )
    const visible: TaggingJob[] = []
    const updates: TaggingJob[] = []
    for (const job of candidates) {
      const batch = await tx.batch(job.batchId)
      if (!batch || !canEdit(batch, actor)) continue
      if (
        job.leaseExpiresAt! <= d.now() &&
        job.recoveryNeededAt === undefined
      ) {
        job.recoveryNeededAt = d.now()
        updates.push(job)
      }
      visible.push(job)
    }
    for (const job of updates) tx.set(job)
    return visible
  })
}

/**
 * Recover an eligible orphaned job while checking its current state and actor's access.
 */
export async function recoverLocalOrphanJob(
  d: JobsDeps,
  actor: Actor,
  id: string,
  claimId: string
): Promise<Outcome<TaggingJob>> {
  if (!localQueueEnabled(d)) return { ok: false, error: 'forbidden' }
  return d.store.transaction(async (tx) => {
    const job = await tx.get(id)
    if (
      !job ||
      job.localScope !== d.localScope ||
      job.queueRunId ||
      job.route === 'hosted'
    )
      return { ok: false, error: 'not_found' }
    const batch = await tx.batch(job.batchId)
    if (!batch || !canEdit(batch, actor))
      return { ok: false, error: 'forbidden' }
    if (
      job.state !== 'claimed' ||
      job.claimId !== claimId ||
      job.leaseExpiresAt! > d.now()
    )
      return { ok: false, error: 'claim_mismatch' }
    const recovered: TaggingJob = {
      ...job,
      state: 'failed',
      endedAt: d.now(),
      failure: 'worker_confirmed_stopped',
      recoveredBy: actor.uid,
    }
    tx.set(recovered)
    return { ok: true, value: recovered }
  })
}
