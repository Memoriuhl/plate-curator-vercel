import type { ModelAdapter } from '../../worker/model'
import { claimJob, getJob, reportResult } from './jobs'
import type { JobsDeps, TaggingJob } from './types'

export const HOSTED_WORKER = 'hosted'
export const CHUNK_SIZE = 5
export const CHUNKS_IN_FLIGHT = 2

export type HostedPlate = { id: string; state: string; displayName: string; image: string; tags: string[]; imageUrl?: string }
export type HostedDeps = {
  jobs: JobsDeps
  adapter: ModelAdapter
  plate(job: TaggingJob): Promise<HostedPlate | null>
  image(plate: HostedPlate): Promise<string | null>
}
export type FinalOutcome = 'completed' | 'stale' | 'failed'
export type PlateOutcome = FinalOutcome | 'retry'
export type ChunkResult = { outcomes: Record<string, PlateOutcome>; retryAfterMs: number | null }

function errorStatus(error: unknown) {
  const status = (error as { status?: unknown })?.status
  return typeof status === 'number' ? status : null
}

function transient(status: number | null) {
  return status === null || status === 408 || status === 429 || status >= 500
}

export async function tagHostedJob(d: HostedDeps, jobId: string): Promise<{ outcome: PlateOutcome; retryAfterMs?: number }> {
  const existing = await getJob(d.jobs, jobId)
  if (!existing || existing.state === 'expired') return { outcome: 'failed' }
  if (existing.state === 'completed') return { outcome: 'completed' }

  const claim = await claimJob(d.jobs, HOSTED_WORKER, jobId)
  if (!claim.ok) return { outcome: 'failed' }
  if (claim.value.job.state === 'completed') return { outcome: 'completed' }

  const plate = await d.plate(claim.value.job)
  if (!plate) return { outcome: 'failed' }

  const start = d.jobs.now()
  let backend = d.adapter.backend
  let suggestions: string[] = []
  let usage: Record<string, number> | undefined
  try {
    const image = await d.image(plate)
    if (image === null) backend = 'missing-image'
    else {
      const result = await d.adapter.suggest({ imageB64: image, plate })
      suggestions = result.tags
      usage = result.usage
    }
  } catch (error) {
    if (!transient(errorStatus(error))) return { outcome: 'failed' }
    const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs
    return { outcome: 'retry', ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}) }
  }

  const report = await reportResult(d.jobs, HOSTED_WORKER, jobId, claim.value.claimId, {
    suggestions, backend, model: d.adapter.model, promptVersion: d.adapter.promptVersion,
    durationMs: Math.max(0, d.jobs.now() - start), ...(usage ? { usage } : {}),
  })
  if (report.ok) return { outcome: 'completed' }
  return { outcome: report.error === 'stale_input' ? 'stale' : 'failed' }
}

export async function tagHostedChunk(d: HostedDeps, jobIds: string[]): Promise<ChunkResult> {
  const settled = await Promise.allSettled(jobIds.map(id => tagHostedJob(d, id)))
  const outcomes: Record<string, PlateOutcome> = {}
  let retryAfterMs: number | null = null
  settled.forEach((result, index) => {
    const value = result.status === 'fulfilled' ? result.value : { outcome: 'retry' as const }
    outcomes[jobIds[index]] = value.outcome
    if ('retryAfterMs' in value && typeof value.retryAfterMs === 'number') retryAfterMs = Math.max(retryAfterMs ?? 0, value.retryAfterMs)
  })
  return { outcomes, retryAfterMs }
}

export function retryDelayMs(result: ChunkResult, attempt: number) {
  return Math.max(result.retryAfterMs ?? 0, 2 ** attempt * 10_000)
}

export function finalOutcomes(result: ChunkResult): Record<string, FinalOutcome> {
  return Object.fromEntries(Object.entries(result.outcomes).map(([id, outcome]) => [id, outcome === 'retry' ? 'failed' : outcome]))
}

export function chunks<T>(items: T[], size = CHUNK_SIZE): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
