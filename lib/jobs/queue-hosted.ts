import { claimHostedQueueJob, getJob, expireJob } from './jobs'
import { tagHostedJob, type HostedDeps } from './hosted'
import type { JobsDeps, TaggingJob } from './types'

// Invoked by the durable coordinator after the job and hook have been persisted.
// Local work returns immediately and remains available to the desktop claimant.
export async function executeHostedQueueStage(jobs: JobsDeps, id: string, deps: (modelId: string) => Promise<HostedDeps>, research?: (job: TaggingJob) => Promise<'waiting' | 'settled'>) {
  const job = await getJob(jobs, id)
  if (!job?.queueRunId || job.route !== 'hosted' || job.state === 'completed' || ['failed', 'cancelled', 'expired'].includes(job.state)) return 'settled'
  // A previous call has returned before this coordinator retries. The bounded
  // inference lease may expire, unlike time spent queued without a reservation.
  const run = await jobs.store.transaction(tx => tx.getRun(job.queueRunId!))
  const asynchronousResearch = job.stage === 'research' && job.state === 'claimed' && !!job.eve
  if (!run || run.localScope !== jobs.localScope || !['queued', 'running'].includes(run.status) || !asynchronousResearch && (run.cancelRequestedAt !== undefined || job.state === 'claimed' && job.leaseExpiresAt! <= jobs.now())) {
    await expireJob(jobs, id)
    return 'settled'
  }
  if (job.stage === 'research') {
    if (!research) throw Error('Hosted research dispatcher is unavailable')
    // An Eve receipt may still have a physical call in progress. Poll settlement
    // before releasing its reservation, including cancellation and lease expiry.
    if (asynchronousResearch) return research(job)
    const claim = await claimHostedQueueJob(jobs, id)
    return claim ? research(claim.job) : 'waiting'
  }
  const result = await tagHostedJob(await deps(job.modelId!), id)
  if (result.outcome === 'waiting' || result.outcome === 'retry') return result.outcome
  if (result.outcome !== 'completed') await expireJob(jobs, id)
  return 'settled'
}
