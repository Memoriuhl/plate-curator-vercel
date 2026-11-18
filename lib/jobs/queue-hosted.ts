import { getJob, expireJob } from './jobs'
import { tagHostedJob, type HostedDeps } from './hosted'
import type { JobsDeps } from './types'

// Invoked by the durable coordinator after the job and hook have been persisted.
// Local work returns immediately and remains available to the desktop claimant.
export async function executeHostedQueueStage(jobs: JobsDeps, id: string, deps: (modelId: string) => Promise<HostedDeps>) {
  const job = await getJob(jobs, id)
  if (!job?.queueRunId || job.route !== 'hosted' || job.state === 'completed' || ['failed', 'cancelled', 'expired'].includes(job.state)) return 'settled'
  // A previous call has returned before this coordinator retries. The bounded
  // inference lease may expire, unlike time spent queued without a reservation.
  const run = (await jobs.store.transaction(tx => tx.runs())).find(run => run.id === job.queueRunId)
  if (!run || !['queued', 'running'].includes(run.status) || run.cancelRequestedAt !== undefined || job.state === 'claimed' && job.leaseExpiresAt! <= jobs.now()) {
    await expireJob(jobs, id)
    return 'settled'
  }
  const result = await tagHostedJob(await deps(job.modelId!), id)
  if (result.outcome === 'waiting' || result.outcome === 'retry') return result.outcome
  if (result.outcome !== 'completed') await expireJob(jobs, id)
  return 'settled'
}
