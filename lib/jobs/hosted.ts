import type { ModelAdapter } from '../../worker/model'
import { claimJob, claimHostedQueueJob, getJob, reportResult } from './jobs'
import type { JobsDeps, TaggingJob } from './types'
import { HostedModelFailure } from '../models/routing'

export const HOSTED_WORKER = 'hosted'
export const CHUNK_SIZE = 5
export const CHUNKS_IN_FLIGHT = 2

export type HostedPlate = {
  id: string
  state: string
  displayName: string
  image: string
  tags: string[]
  imageUrl?: string
}
export type HostedDeps = {
  jobs: JobsDeps
  adapter: ModelAdapter
  plate(job: TaggingJob): Promise<HostedPlate | null>
  image(plate: HostedPlate): Promise<string | null>
}
export type FinalOutcome = 'completed' | 'stale' | 'failed'
export type PlateOutcome = FinalOutcome | 'retry' | 'waiting'
export type ChunkResult = {
  outcomes: Record<string, PlateOutcome>
  retryAfterMs: number | null
}

/** Read an upstream HTTP status when the hosted adapter supplies one. */
function errorStatus(error: unknown) {
  const status = (error as { status?: unknown })?.status
  return typeof status === 'number' ? status : null
}

/** Classify transport failures and retryable HTTP responses for the hosted retry loop. */
function transient(status: number | null) {
  return status === null || status === 408 || status === 429 || status >= 500
}

/**
 * Claim and execute one hosted tagging job, then report its result against the current
 * plate revision.
 */
export async function tagHostedJob(
  d: HostedDeps,
  jobId: string
): Promise<{ outcome: PlateOutcome; retryAfterMs?: number }> {
  const existing = await getJob(d.jobs, jobId)
  if (!existing || existing.state === 'expired') return { outcome: 'failed' }
  if (existing.state === 'completed') return { outcome: 'completed' }

  const reserved = existing.queueRunId
    ? await claimHostedQueueJob(d.jobs, jobId)
    : undefined
  if (existing.queueRunId && !reserved) return { outcome: 'waiting' }
  const claim = reserved
    ? { ok: true as const, value: reserved }
    : await claimJob(d.jobs, HOSTED_WORKER, jobId)
  if (!claim.ok) return { outcome: 'failed' }
  if (claim.value.job.state === 'completed') return { outcome: 'completed' }

  const plate = await d.plate(claim.value.job)
  if (!plate) return { outcome: 'failed' }

  const start = d.jobs.now()
  let backend = d.adapter.backend
  let model = d.adapter.model
  let suggestions: string[] = []
  let usage: Record<string, number> | undefined
  try {
    const image = await d.image(plate)
    if (image === null) backend = 'missing-image'
    else {
      const result = await d.adapter.suggest({ imageB64: image, plate })
      suggestions = result.tags
      usage = result.usage
      model = result.model ?? model
    }
  } catch (error) {
    if (error instanceof HostedModelFailure) {
      await d.jobs.store.transaction(async (tx) => {
        const job = await tx.get(jobId)
        if (job?.state !== 'claimed' || job.claimId !== claim.value.claimId)
          return
        const run = job.queueRunId ? await tx.getRun(job.queueRunId) : null
        tx.set({
          ...job,
          state: run?.cancelRequestedAt !== undefined ? 'cancelled' : 'failed',
          endedAt: d.jobs.now(),
          failure: error.message,
        })
      })
      return { outcome: 'failed' }
    }
    if (!transient(errorStatus(error))) return { outcome: 'failed' }
    const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs
    return {
      outcome: 'retry',
      ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
    }
  }

  const report = await reportResult(
    d.jobs,
    HOSTED_WORKER,
    jobId,
    claim.value.claimId,
    {
      suggestions,
      backend,
      model,
      promptVersion: d.adapter.promptVersion,
      durationMs: Math.max(0, d.jobs.now() - start),
      ...(usage ? { usage } : {}),
    }
  )
  if (report.ok) return { outcome: 'completed' }
  return { outcome: report.error === 'stale_input' ? 'stale' : 'failed' }
}

/**
 * Run a chunk of hosted jobs concurrently and retain their outcomes and retry delays
 * independently.
 */
export async function tagHostedChunk(
  d: HostedDeps,
  jobIds: string[]
): Promise<ChunkResult> {
  const settled = await Promise.allSettled(
    jobIds.map((id) => tagHostedJob(d, id))
  )
  const outcomes: Record<string, PlateOutcome> = {}
  let retryAfterMs: number | null = null
  settled.forEach((result, index) => {
    const value =
      result.status === 'fulfilled'
        ? result.value
        : { outcome: 'retry' as const }
    outcomes[jobIds[index]] = value.outcome
    if ('retryAfterMs' in value && typeof value.retryAfterMs === 'number')
      retryAfterMs = Math.max(retryAfterMs ?? 0, value.retryAfterMs)
  })
  return { outcomes, retryAfterMs }
}

/**
 * Use exponential backoff while honoring a longer retry interval requested by the
 * provider.
 */
export function retryDelayMs(result: ChunkResult, attempt: number) {
  return Math.max(result.retryAfterMs ?? 0, 2 ** attempt * 10_000)
}

/** Turn unresolved jobs into failures when the workflow exhausts its retry budget. */
export function finalOutcomes(
  result: ChunkResult
): Record<string, FinalOutcome> {
  return Object.fromEntries(
    Object.entries(result.outcomes).map(([id, outcome]) => [
      id,
      outcome === 'retry' || outcome === 'waiting' ? 'failed' : outcome,
    ])
  )
}

/** Partition jobs into bounded chunks so hosted execution can control concurrency. */
export function chunks<T>(items: T[], size = CHUNK_SIZE): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size))
  return out
}
