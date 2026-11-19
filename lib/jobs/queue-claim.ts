import { shouldReuseSavedSources } from '../research/enrichment'
import type { readLocalWorkerCapabilities } from './capabilities'
import { gatewayTagConcurrency, inQueueWindow } from './queue-parallel'
import { compareQueueOrder } from './queue-order'
import type { PipelineRun, QueueWait } from './queue-types'
import type { JobsDeps, TaggingJob } from './types'

export type LocalClaimFeatures = {
  supportsSavedSources?: boolean
  enhanceImage?: boolean
}

export type QueueWorker = Awaited<
  ReturnType<typeof readLocalWorkerCapabilities>
>

/**
 * Capacity limits. A claimed job that is not part of a parallel Tag window holds its
 * GPU or I/O slot; hosted single jobs share the two I/O slots with the desktop. Every
 * hosted Tag job also counts toward the Gateway's six concurrent calls.
 */
type Limit = 'gpu' | 'io' | 'gateway'
const limits: Record<Limit, number> = {
  gpu: 1,
  io: 2,
  gateway: gatewayTagConcurrency,
}
type Lane = 'local' | 'hosted'

function jobLimits(job: TaggingJob): Limit[] {
  const held: Limit[] = job.parallelTag ? [] : [job.resourceClass ?? 'gpu']
  if (job.route === 'hosted' && !job.stage) held.push('gateway')
  return held
}

function lane(job: TaggingJob): Lane {
  return job.route === 'hosted' ? 'hosted' : 'local'
}

/** An entry in a waiting line: a queued job, or a held place with no job yet. */
type LineEntry = {
  lane: Lane
  limits: Limit[]
  order: Parameters<typeof compareQueueOrder>[0]
  step: number
  createdAt: number
  id: string
  job?: TaggingJob
}

export type QueueSchedule = ReturnType<typeof queueSchedule>

function queueResourceClaims(jobs: TaggingJob[], scope: string | undefined) {
  return jobs.filter(
    (job) =>
      job.localScope === scope &&
      job.state === 'claimed' &&
      (job.route !== 'hosted' || job.queueRunId)
  )
}

function workerRequirement(job: TaggingJob, features: LocalClaimFeatures) {
  if (job.stage === 'enhance-image' && !features.enhanceImage)
    return 'image_worker'
  if (
    job.stage === 'research' &&
    job.route !== 'hosted' &&
    !features.supportsSavedSources &&
    shouldReuseSavedSources(job.stageOptions)
  )
    return 'saved_sources_worker'
}

function activeRun(run: PipelineRun, scope: string | undefined) {
  return (
    run.localScope === scope &&
    (run.status === 'queued' || run.status === 'running') &&
    run.cancelRequestedAt === undefined
  )
}

/**
 * Order the scope's waiting jobs by run submission, then step, in one line per lane
 * (desktop and hosted). A job can be claimed when every limit it needs has room for
 * the entries ahead of it in its lane plus itself, so any free capacity goes to the
 * earliest submitted job, from any curator.
 *
 * A run whose next GPU step has not been dispatched yet still holds its place in the
 * GPU line, so GPU steps run strictly in submission order across stage boundaries. The
 * place is held only while the run's workflow is bound and the run is not waiting for
 * an image choice. Hosted steps hold no place between steps.
 */
export function queueSchedule(
  scope: string | undefined,
  jobs: TaggingJob[],
  runs: PipelineRun[],
  features: LocalClaimFeatures = {}
) {
  const claims = queueResourceClaims(jobs, scope)
  const usage: Record<Limit, number> = { gpu: 0, io: 0, gateway: 0 }
  for (const claim of claims)
    for (const limit of jobLimits(claim)) usage[limit]++

  const byId = new Map(runs.map((run) => [run.id, run]))
  const line: LineEntry[] = []
  const dispatched = new Set<string>()
  for (const job of jobs) {
    if (job.localScope !== scope) continue
    if (job.queueRunId && (job.state === 'queued' || job.state === 'claimed'))
      dispatched.add(`${job.queueRunId}:${job.queueAttempt}:${job.queueStep}`)
    if (job.state !== 'queued' || workerRequirement(job, features)) continue
    const entry = {
      lane: lane(job),
      limits: jobLimits(job),
      step: job.queueStep ?? 0,
      createdAt: job.createdAt,
      id: job.id,
      job,
    }
    if (!job.queueRunId) {
      // Older standalone hosted jobs keep their by-id lifecycle outside the queue.
      if (job.route !== 'hosted')
        line.push({ ...entry, order: { id: job.id, createdAt: job.createdAt } })
      continue
    }
    const run = byId.get(job.queueRunId)
    const attempt = run?.attempts.at(-1)
    if (
      run &&
      attempt &&
      activeRun(run, scope) &&
      attempt.number === job.queueAttempt &&
      inQueueWindow(attempt, job.queueStep) &&
      attempt.jobIds.includes(job.id)
    )
      line.push({ ...entry, order: run })
  }
  for (const run of runs) {
    const attempt = run.attempts.at(-1)
    const id = `${run.id}:${attempt?.number}:${attempt?.cursor}`
    if (
      !attempt?.workflowId ||
      !activeRun(run, scope) ||
      run.waitReason === 'image_choice' ||
      attempt.steps[attempt.cursor]?.resourceClass !== 'gpu' ||
      dispatched.has(id)
    )
      continue
    line.push({
      lane: 'local',
      limits: ['gpu'],
      order: run,
      step: attempt.cursor,
      createdAt: run.createdAt,
      id,
    })
  }
  line.sort(
    (a, b) =>
      compareQueueOrder(a.order, b.order) ||
      a.step - b.step ||
      a.createdAt - b.createdAt ||
      a.id.localeCompare(b.id)
  )

  // For each job, count the entries ahead of it in its lane that need the same limit.
  const ahead = new Map<string, Partial<Record<Limit, number>>>()
  const seen: Record<Lane, Record<Limit, number>> = {
    local: { gpu: 0, io: 0, gateway: 0 },
    hosted: { gpu: 0, io: 0, gateway: 0 },
  }
  for (const entry of line) {
    const position: Partial<Record<Limit, number>> = {}
    for (const limit of entry.limits)
      position[limit] = seen[entry.lane][limit]++
    if (entry.job) ahead.set(entry.job.id, position)
  }

  /** Check whether the job is in line and every limit it needs has room for it now. */
  function canClaim(job: TaggingJob) {
    const position = ahead.get(job.id)
    return (
      position !== undefined &&
      jobLimits(job).every(
        (limit) => usage[limit] + (position[limit] ?? 0) < limits[limit]
      )
    )
  }

  return {
    claims,
    /** Queued jobs that could be claimed now, earliest submission first. */
    open: () =>
      line.flatMap((entry) =>
        entry.job && canClaim(entry.job) ? [entry.job] : []
      ),
    /** Check whether the job is in line but waits for earlier entries or capacity. */
    behind: (job: TaggingJob) => ahead.has(job.id) && !canClaim(job),
  }
}

export function queuedStageWait(
  run: PipelineRun,
  job: TaggingJob | undefined,
  schedule: QueueSchedule,
  worker: QueueWorker,
  now: number
): QueueWait | undefined {
  const betweenSteps =
    run.status === 'running' &&
    (run.waitReason === 'worker' || run.waitReason === 'resource') &&
    job?.state !== 'claimed'
  if (
    run.cancelRequestedAt !== undefined ||
    (run.status !== 'queued' && !betweenSteps)
  )
    return
  if (!run.attempts.at(-1)?.workflowId) return 'starting_workflow'
  if (!job) return 'dispatching'
  if (job.state !== 'queued') return 'settling'
  if (!job.parallelTag) {
    const resource = job.resourceClass ?? 'gpu'
    const occupied = schedule.claims.filter(
      (claim) =>
        !claim.parallelTag && (claim.resourceClass ?? 'gpu') === resource
    )
    if (occupied.length >= limits[resource]) {
      const recovery = occupied.filter(
        (claim) =>
          claim.recoveryNeededAt !== undefined ||
          (claim.leaseExpiresAt !== undefined && claim.leaseExpiresAt <= now)
      )
      return recovery.length >= limits[resource]
        ? `${resource}_recovery`
        : `${resource}_busy`
    }
  }
  if (schedule.behind(job)) return 'prior_run'
  if (job.route === 'hosted') return 'hosted'
  if (
    worker.reportedAt === null ||
    worker.pollIntervalMs === null ||
    worker.reportedAt > now ||
    now - worker.reportedAt > 2 * worker.pollIntervalMs
  )
    return 'worker_offline'
  return workerRequirement(job, workerFeatures(worker)) ?? 'worker_claim'
}

export function workerFeatures(worker: QueueWorker): LocalClaimFeatures {
  return {
    supportsSavedSources:
      'supportsSavedSources' in worker && worker.supportsSavedSources,
    enhanceImage: worker['enhance-image'].available,
  }
}

/**
 * Pick the earliest-submitted job the claimant can take now. A desktop worker gets the
 * first open desktop job; the hosted coordinator gets the job it asked for, if open.
 */
export function localClaimCandidate(
  d: JobsDeps,
  jobs: TaggingJob[],
  runs: PipelineRun[],
  route: Lane = 'local',
  features: LocalClaimFeatures = {},
  hostedJobId?: string
) {
  if (!localClaimsEnabled(d)) return null
  const open = queueSchedule(d.localScope, jobs, runs, features)
    .open()
    .filter((job) => lane(job) === route)
  if (hostedJobId !== undefined)
    return open.find((job) => job.id === hostedJobId) ?? null
  return open[0] ?? null
}

/** Check that local claims are enabled and the worker's queue scope is configured. */
export function localClaimsEnabled(d: JobsDeps) {
  return process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' && !!d.localScope
}
