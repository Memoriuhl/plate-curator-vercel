import type { TaggingJob } from './types'

/** Accept queued jobs and claimed jobs whose leases have expired. */
export function claimable(job: TaggingJob, now: number) {
  return job.state === 'queued' || (job.state === 'claimed' && job.leaseExpiresAt !== undefined && job.leaseExpiresAt <= now)
}

export function isStandaloneDesktopJob(job: TaggingJob, localScope?: string) {
  return !job.queueRunId && job.localScope === localScope && job.route !== 'hosted'
}

export function compareJobAge(a: TaggingJob, b: TaggingJob) {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id)
}
