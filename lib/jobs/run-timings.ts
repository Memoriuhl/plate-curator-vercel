import type { Actor } from '../review/types'
import { taggingModel } from '../tagging/models'
import type { LocalRunStage } from './queue-types'
import type { JobsDeps, TaggingJob } from './types'

type TimingDevice = 'desktop' | 'gateway' | 'eve'
export type RunTimings = Partial<Record<string, number>>

const samplesPerEstimate = 50

export function runTimingKey(stage: LocalRunStage, device: TimingDevice, model?: string) {
  return JSON.stringify([stage, device, model ?? null])
}

function timingSample(job: TaggingJob) {
  const result = job.result
  if (job.state !== 'completed' || job.completedAt === undefined || !result || result.stageError ||
      result.backend === 'missing-image' || !Number.isFinite(result.durationMs) || result.durationMs <= 0 || job.stage === 'order') return null

  const stage = job.stage ?? 'tag'
  const device = job.route !== 'hosted' ? 'desktop' : stage === 'research' ? 'eve' : 'gateway'
  // Older Eve reports began timing at enqueue. Only use claim-based measurements.
  if (device === 'eve' && job.startedAt === undefined) return null
  const model = stage === 'group' ? (job.stageOptions?.visionTiebreak ? taggingModel(job.modelId)?.model : undefined)
    : stage === 'wiki-link' || stage === 'find-image' ? undefined : result.model
  return { key: runTimingKey(stage, device, model), device, workerId: job.workerId, durationMs: result.durationMs, completedAt: job.completedAt }
}

export async function listRunTimings(d: JobsDeps, actor: Actor): Promise<RunTimings> {
  const [jobs, worker] = await Promise.all([
    d.store.transaction(tx => tx.list()),
    d.localScope ? d.store.readCapabilities(d.localScope) : null,
  ])
  const history = jobs.flatMap(job => {
    if (job.env !== d.store.env || job.localScope !== d.localScope || (actor.role !== 'owner' && job.requestedBy !== actor.uid)) return []
    const sample = timingSample(job)
    return sample ? [sample] : []
  }).sort((a, b) => b.completedAt - a.completedAt)

  // The latest heartbeat identifies the desktop in this scope. Legacy workers
  // can be identified by their most recent successful job.
  const desktop = worker?.workerId ?? history.find(sample => sample.device === 'desktop' && sample.workerId)?.workerId
  const totals = new Map<string, { count: number; durationMs: number }>()
  for (const sample of history) {
    if (sample.device === 'desktop' && (!desktop || sample.workerId !== desktop)) continue
    const total = totals.get(sample.key) ?? { count: 0, durationMs: 0 }
    if (total.count >= samplesPerEstimate) continue
    total.count++
    total.durationMs += sample.durationMs
    totals.set(sample.key, total)
  }
  return Object.fromEntries([...totals].map(([key, total]) => [key, total.durationMs / total.count]))
}
