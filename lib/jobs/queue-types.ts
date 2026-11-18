import type { Environment, PipelineStage, TaggingJob } from './types'
import type { PipelineOptions } from './pipeline-options'
import type { RunProjection } from './queue-projection'
import type { Role } from '../review/types'
import type { RunStep } from './pipeline-plan'

export type LocalRunStage = Exclude<PipelineStage, 'order'> | 'tag'
export type ResourceClass = 'gpu' | 'io'
export type QueueWait =
  | 'starting_workflow'
  | 'dispatching'
  | 'settling'
  | 'worker_offline'
  | 'saved_sources_worker'
  | 'image_worker'
  | 'gpu_busy'
  | 'io_busy'
  | 'gpu_recovery'
  | 'io_recovery'
  | 'hosted'
  | 'worker_claim'
export type RunStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type RunAttempt = {
  number: number
  requestId: string
  createdAt: number
  jobIds: string[]
  status: RunStatus
  endedAt?: number
  error?: string
  outcome?: 'no_result' | 'partial'
  noResultCount?: number
  projection?: RunProjection
  workflowId?: string
  workflowUrl?: string | null
  cursor: number
  completedJobIds: string[]
  steps: RunStep[]
  choices: Record<string, string>
}
export type PipelineRun = {
  id: string
  requestId: string
  fingerprint: string
  selectionId?: string
  selectionIndex?: number
  batchId: string
  requestedBy: string
  requestedByName?: string | null
  requestedByRole?: Role
  incrementalDrafts?: boolean
  draftPlateIds?: string[]
  env: Environment
  localScope: string
  plateIds: string[]
  stages: LocalRunStage[]
  modelId?: string
  tagModelId?: string
  researchModel?: { id: string; executor: 'desktop' | 'eve'; model: string }
  resourceClass: ResourceClass
  options: PipelineOptions
  previewOnly: boolean
  createdAt: number
  queuedAt: number
  enqueueSequence: number
  updatedAt: number
  lastDispatchedAt?: number
  waitReason?: 'worker' | 'resource' | 'inference' | 'image_choice' | 'recovery'
  status: RunStatus
  dismissedAt?: number
  cancelRequestedAt?: number
  attempts: RunAttempt[]
}
export type QueueRunView = PipelineRun & {
  queueWait?: QueueWait
  jobs: TaggingJob[]
  editable: boolean
  applied: boolean
  batchName?: string
  plates?: import('./run-plates').RunPlateDetail[]
  cards?: import('../catalog/dashboard-types').PlateCardData[]
  progress?: import('./run-progress').PipelineProgress
}
export type QueueRunSummary = Omit<PipelineRun, 'attempts' | 'fingerprint'> & {
  attempts: (Omit<
    RunAttempt,
    'projection' | 'steps' | 'completedJobIds' | 'jobIds' | 'choices'
  > & {
    stepCount?: number
    completedCount?: number
    steps?: RunStep[]
    completedJobIds?: string[]
  })[]
  queueWait?: QueueWait
  jobs: TaggingJob[]
  editable: boolean
  applied: boolean
  batchName?: string
  progress?: import('./run-progress').PipelineProgress
}
export type EnqueueInput = {
  requestId: string
  batchId: string
  plateIds: string[]
  stages: LocalRunStage[]
  modelId?: string
  tagModelId?: string
  researchModelId?: string
  options?: PipelineOptions
  previewOnly?: boolean
}
export type QueueError =
  | 'forbidden'
  | 'not_found'
  | 'invalid_state'
  | 'bad_request'
  | 'request_mismatch'
  | 'stale_input'
  | 'payload_too_large'
  | 'attempt_limit'
  | 'publish_in_progress'
export type QueueOutcome<T> =
  { ok: true; value: T } | { ok: false; error: QueueError }
