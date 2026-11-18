import { shouldReuseSavedSources } from '../research/enrichment'
import type { readLocalWorkerCapabilities } from './capabilities'
import type { PipelineRun, QueueWait, ResourceClass } from './queue-types'
import type { JobsDeps, TaggingJob } from './types'

export type LocalClaimFeatures = { supportsSavedSources?: boolean; enhanceImage?: boolean }

const queueLimits = { gpu: 1, io: 2 } as const
export type QueueWorker = Awaited<ReturnType<typeof readLocalWorkerCapabilities>>

export function queueResourceClaims(jobs: TaggingJob[], scope: string | undefined) {
  return jobs.filter(job => job.localScope === scope && job.state === 'claimed' && (job.route !== 'hosted' || job.queueRunId))
}

function workerRequirement(job: TaggingJob, features: LocalClaimFeatures) {
  if (job.stage === 'enhance-image' && !features.enhanceImage) return 'image_worker'
  if (job.stage === 'research' && job.route !== 'hosted' && !features.supportsSavedSources && shouldReuseSavedSources(job.stageOptions)) return 'saved_sources_worker'
}

export function queuedStageWait(run: PipelineRun, job: TaggingJob | undefined, claims: TaggingJob[], worker: QueueWorker, now: number): QueueWait | undefined {
  if (run.status !== 'queued' || run.cancelRequestedAt !== undefined) return
  if (!run.attempts.at(-1)?.workflowId) return 'starting_workflow'
  if (!job) return 'dispatching'
  if (job.state !== 'queued') return 'settling'
  const resource = job.resourceClass ?? 'gpu'
  const occupied = claims.filter(claim => (claim.resourceClass ?? 'gpu') === resource)
  if (occupied.length >= queueLimits[resource]) {
    const recovery = occupied.filter(claim => claim.recoveryNeededAt !== undefined || claim.leaseExpiresAt !== undefined && claim.leaseExpiresAt <= now)
    return recovery.length >= queueLimits[resource] ? `${resource}_recovery` : `${resource}_busy`
  }
  if (job.route === 'hosted') return 'hosted'
  if (worker.reportedAt === null || worker.pollIntervalMs === null || worker.reportedAt > now || now - worker.reportedAt > 2 * worker.pollIntervalMs) return 'worker_offline'
  return workerRequirement(job, { supportsSavedSources: 'supportsSavedSources' in worker && worker.supportsSavedSources, enhanceImage: worker['enhance-image'].available }) ?? 'worker_claim'
}

export function localClaimCandidate(d: JobsDeps, jobs: TaggingJob[], runs: PipelineRun[], route: 'local' | 'hosted' = 'local', features: LocalClaimFeatures = {}) {
  if (!localClaimsEnabled(d)) return null
  const scoped = jobs.filter(job => job.localScope === d.localScope)
  const occupied: Record<ResourceClass, number> = { gpu: 0, io: 0 }
  for (const job of queueResourceClaims(scoped, d.localScope)) occupied[job.resourceClass ?? 'gpu']++
  const lastByUser = new Map<string, number>()
  for (const run of runs) if (run.localScope === d.localScope) lastByUser.set(run.requestedBy, Math.max(lastByUser.get(run.requestedBy) ?? 0, run.lastDispatchedAt ?? 0))
  return scoped.filter(job => {
    if (workerRequirement(job, features)) return false
    if ((job.route === 'hosted') !== (route === 'hosted') || occupied[job.resourceClass ?? 'gpu'] >= queueLimits[job.resourceClass ?? 'gpu']) return false
    if (route === 'hosted' && !job.queueRunId) return false
    if (!job.queueRunId) return job.state === 'queued'
    const run = runs.find(run => run.id === job.queueRunId && run.localScope === d.localScope)
    const attempt = run?.attempts.at(-1)
    return job.state === 'queued' && run && attempt && ['queued', 'running'].includes(run.status) && run.cancelRequestedAt === undefined &&
      attempt.number === job.queueAttempt && attempt.cursor === job.queueStep && attempt.jobIds.includes(job.id)
  }).sort((a, b) => (lastByUser.get(a.requestedBy) ?? 0) - (lastByUser.get(b.requestedBy) ?? 0) ||
    a.createdAt - b.createdAt || (a.queueOrder ?? 0) - (b.queueOrder ?? 0) || a.id.localeCompare(b.id))[0] ?? null
}

export function localClaimsEnabled(d: JobsDeps) { return process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' && !!d.localScope }
