import { queueLimits } from './queue'
import type { PipelineRun, ResourceClass } from './queue-types'
import type { JobsDeps, TaggingJob } from './types'

export function localClaimCandidate(d: JobsDeps, jobs: TaggingJob[], runs: PipelineRun[]) {
  if (!localClaimsEnabled(d)) return null
  const scoped = jobs.filter(job => job.localScope === d.localScope)
  const occupied: Record<ResourceClass, number> = { gpu: 0, io: 0 }
  for (const job of scoped) if (job.state === 'claimed') occupied[job.resourceClass ?? 'gpu']++
  const lastByUser = new Map<string, number>()
  for (const run of runs) if (run.localScope === d.localScope) lastByUser.set(run.requestedBy, Math.max(lastByUser.get(run.requestedBy) ?? 0, run.lastDispatchedAt ?? 0))
  return scoped.filter(job => {
    if (job.route === 'hosted' || occupied[job.resourceClass ?? 'gpu'] >= queueLimits[job.resourceClass ?? 'gpu']) return false
    if (!job.queueRunId) return job.state === 'queued'
    const run = runs.find(run => run.id === job.queueRunId && run.localScope === d.localScope)
    const attempt = run?.attempts.at(-1)
    return job.state === 'queued' && run && attempt && ['queued', 'running'].includes(run.status) && run.cancelRequestedAt === undefined &&
      attempt.number === job.queueAttempt && attempt.cursor === job.queueStep && attempt.jobIds.includes(job.id)
  }).sort((a, b) => (lastByUser.get(a.requestedBy) ?? 0) - (lastByUser.get(b.requestedBy) ?? 0) ||
    a.createdAt - b.createdAt || (a.queueOrder ?? 0) - (b.queueOrder ?? 0) || a.id.localeCompare(b.id))[0] ?? null
}

export function localClaimsEnabled(d: JobsDeps) { return process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' && !!d.localScope }
