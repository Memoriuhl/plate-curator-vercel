import type { Plate } from '../catalog/types'
import type {
  EditableFields,
  ProposedEdit,
  ReviewBatch,
  ReviewStore,
  Role,
} from '../review/types'
import type {
  GroupInput,
  GroupSuggestion,
  ImageSuggestion,
} from './specialized-suggestions'

import type { WorkerCapabilityRecord } from './capabilities'
import type { PipelineRun, ResourceClass } from './queue-types'
import type {
  EnhancedImageSuggestion,
  ImageEnhancementOptions,
} from './image-enhancement'
import type { ImageGroupOptions } from './image-options'

export type Environment = 'production' | 'development' | `preview:${string}`
export type PipelineStage =
  | 'research'
  | 'describe'
  | 'story'
  | 'wiki-link'
  | 'colors'
  | 'find-image'
  | 'enhance-image'
  | 'group'
  | 'order'
export type FieldsSuggestion = {
  kind: 'fields'
  stage: PipelineStage
  fields: Partial<EditableFields>
  sources: string[]
}
export type FieldSuggestion =
  FieldsSuggestion | ImageSuggestion | GroupSuggestion | EnhancedImageSuggestion
export type StageError =
  'no_sources' | 'no_supported_fields' | 'unavailable' | 'missing_image'
export type JobResult = {
  suggestions: string[]
  fieldSuggestion?: FieldSuggestion
  stageError?: StageError
  backend: string
  model: string
  promptVersion: string
  durationMs: number
  usage?: Record<string, number>
}
export type ReportInput = Omit<
  JobResult,
  'suggestions' | 'fieldSuggestion' | 'stageError'
> & {
  suggestions?: unknown
  fieldSuggestion?: unknown
  stageError?: unknown
  enhancedImage?: unknown
  enhancedImageFrames?: unknown
}
export type TaggingJob = {
  id: string
  batchId: string
  plateId: string
  requestedBy: string
  inputPlate?: Plate
  inputHash: string
  executionHash?: string
  env: Environment
  route?: 'local' | 'hosted'
  modelId?: string
  researchModel?: { id: string; executor: 'desktop' | 'eve'; model: string }
  researchPolicy?: 'fill-missing' | 'replace'
  eve?: { sessionId: string; deliveryId: string }
  stage?: PipelineStage
  localScope?: string
  previewOnly?: boolean
  groupScope?: GroupInput
  standardId?: string
  queueRunId?: string
  queueAttempt?: number
  enqueuedBy?: string
  phaseIndex?: number
  queueStep?: number
  queueOrder?: number
  completionHook?: string
  stageOptions?: ImageGroupOptions &
    Partial<ImageEnhancementOptions> & {
      redoExisting?: boolean
      onlyUnderTagged?: boolean
      policy?: 'fill-missing' | 'replace'
      reuseSavedSources?: boolean
    }
  resourceClass?: ResourceClass
  failure?: string
  createdAt: number
  startedAt?: number
  workflowId?: string
  workflowUrl?: string | null
  state: 'queued' | 'claimed' | 'completed' | 'expired' | 'failed' | 'cancelled'
  endedAt?: number
  recoveryNeededAt?: number
  recoveredBy?: string
  claimId?: string
  workerId?: string
  leaseExpiresAt?: number
  result?: JobResult
  completedAt?: number
  expiredAt?: number
}
export type WorkerToken = {
  hash: string
  workerId: string
  env: Environment
  createdAt: number
  revokedAt: number | null
}
export interface JobsTransaction {
  canQueue?(): Promise<boolean>
  createDraftBatch?(batch: ReviewBatch): Promise<void>
  reviewFields?(
    batchId: string,
    plateIds: string[]
  ): Promise<Map<string, EditableFields>>
  batch(id: string): Promise<ReviewBatch | null>
  runs(): Promise<PipelineRun[]>
  getRun(id: string): Promise<PipelineRun | null>
  setRun(run: PipelineRun): void
  get(id: string): Promise<TaggingJob | null>
  list(plateId?: string): Promise<TaggingJob[]>
  nextStandaloneDesktopJob(
    now: number,
    localScope?: string
  ): Promise<TaggingJob | null>
  listActiveJobs(localScope: string): Promise<TaggingJob[]>
  review(
    batchId: string,
    plateId: string
  ): Promise<{
    fields: EditableFields
    baselineVersion: number
    edit?: ProposedEdit
  } | null>
  commitDraft: ReviewStore['commit']
  pipelineRequesterRole?(uid: string): Promise<Role | null>
  create(job: TaggingJob): void
  set(job: TaggingJob): void
  setEnhancedImage(id: string, bytes: Buffer): void
}
export interface JobsStore {
  env: Environment
  readEnhancedImage(id: string): Promise<Buffer | null>
  readCapabilities(scope: string): Promise<WorkerCapabilityRecord | null>
  writeCapabilities(
    scope: string,
    record: WorkerCapabilityRecord
  ): Promise<void>
  transaction<T>(run: (transaction: JobsTransaction) => Promise<T>): Promise<T>
  getToken(hash: string): Promise<WorkerToken | null>
  createToken(token: WorkerToken): Promise<void>
  revokeToken(hash: string, at: number): Promise<void>
}
export type JobsDeps = {
  store: JobsStore
  baseline(plateId: string): Promise<Plate | null>
  baselineAtVersion?(version: number, plateId: string): Promise<Plate | null>
  stateBaseline?(
    version: number,
    state: string,
    order?: 'snapshot'
  ): Promise<Plate[]>
  configuredOwnerUids?: readonly string[]
  now(): number
  id(): string
  leaseMs: number
  localScope?: string
}
export type JobsError =
  | 'not_found'
  | 'already_exists'
  | 'claim_expired'
  | 'claim_mismatch'
  | 'stale_input'
  | 'result_mismatch'
  | 'invalid_result'
  | 'forbidden'
export type Outcome<T> =
  { ok: true; value: T } | { ok: false; error: JobsError }
