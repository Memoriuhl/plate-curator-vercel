import { claimHostedQueueJob, getJob, expireJob } from './jobs'
import { tagHostedJob, type HostedDeps } from './hosted'
import type { JobsDeps, TaggingJob } from './types'

// Invoked by the durable coordinator after the job and hook have been persisted.
// Local work returns immediately and remains available to the desktop claimant.
type HostedAttempt = {
  outcome: 'waiting' | 'settled' | 'retry'
  retryAfterMs?: number
}
type Research = (job: TaggingJob) => Promise<'waiting' | 'settled'>
type HostedDependencies = (
  modelId: string,
  binding?: TaggingJob['hostedModel']
) => Promise<HostedDeps>

/**
 * Execute a queue stage on its hosted provider and report whether it settled or needs
 * another attempt.
 */
export async function executeHostedQueueStage(
  jobs: JobsDeps,
  id: string,
  deps: HostedDependencies,
  research?: Research
) {
  return (await executeHostedQueueAttempt(jobs, id, deps, research)).outcome
}

export async function executeHostedQueueAttempt(
  jobs: JobsDeps,
  id: string,
  deps: HostedDependencies,
  research?: Research
): Promise<HostedAttempt> {
  const job = await getJob(jobs, id)
  if (
    !job?.queueRunId ||
    job.route !== 'hosted' ||
    job.state === 'completed' ||
    ['failed', 'cancelled', 'expired'].includes(job.state)
  )
    return { outcome: 'settled' }
  // A previous call has returned before this coordinator retries. The bounded
  // inference lease may expire, unlike time spent queued without a reservation.
  const run = await jobs.store.transaction((tx) => tx.getRun(job.queueRunId!))
  const asynchronousResearch =
    job.stage === 'research' && job.state === 'claimed' && !!job.eve
  if (
    !run ||
    run.localScope !== jobs.localScope ||
    !['queued', 'running'].includes(run.status) ||
    (!asynchronousResearch &&
      (run.cancelRequestedAt !== undefined ||
        (job.state === 'claimed' && job.leaseExpiresAt! <= jobs.now())))
  ) {
    await expireJob(jobs, id)
    return { outcome: 'settled' }
  }
  if (job.stage === 'research') {
    if (!research) throw Error('Hosted research dispatcher is unavailable')
    // An Eve receipt may still have a physical call in progress. Poll settlement
    // before releasing its reservation, including cancellation and lease expiry.
    if (asynchronousResearch) return { outcome: await research(job) }
    const claim = await claimHostedQueueJob(jobs, id)
    return { outcome: claim ? await research(claim.job) : 'waiting' }
  }
  const result = await tagHostedJob(
    await deps(job.modelId!, job.hostedModel),
    id
  )
  if (result.outcome === 'waiting' || result.outcome === 'retry')
    return { outcome: result.outcome, retryAfterMs: result.retryAfterMs }
  if (
    result.outcome !== 'completed' &&
    (await getJob(jobs, id))?.state === 'claimed'
  )
    await expireJob(jobs, id)
  return { outcome: 'settled' }
}
