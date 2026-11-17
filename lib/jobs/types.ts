import type { Plate } from '../catalog/types'
import type { EditableFields } from '../review/types'
import type { GroupSuggestion, ImageSuggestion } from './specialized-suggestions'

export type Environment = 'production' | 'development' | `preview:${string}`
export type PipelineStage = 'describe' | 'story' | 'wiki-link' | 'colors' | 'find-image' | 'group' | 'order'
export type FieldsSuggestion = { kind: 'fields'; stage: PipelineStage; fields: Partial<EditableFields>; sources: string[] }
export type FieldSuggestion = FieldsSuggestion | ImageSuggestion | GroupSuggestion
export type StageError = 'no_sources' | 'no_supported_fields'
export type JobResult = { suggestions: string[]; fieldSuggestion?: FieldSuggestion; stageError?: StageError; backend: string; model: string; promptVersion: string; durationMs: number; usage?: Record<string, number> }
export type ReportInput = Omit<JobResult, 'suggestions' | 'fieldSuggestion' | 'stageError'> & { suggestions?: unknown; fieldSuggestion?: unknown; stageError?: unknown }
export type TaggingJob = {
  id: string
  batchId: string
  plateId: string
  requestedBy: string
  inputPlate?: Plate
  inputHash: string
  env: Environment
  route?: 'local' | 'hosted'
  modelId?: string
  stage?: PipelineStage
  localScope?: string
  createdAt: number
  state: 'queued' | 'claimed' | 'completed' | 'expired'
  claimId?: string
  workerId?: string
  leaseExpiresAt?: number
  result?: JobResult
  completedAt?: number
  expiredAt?: number
}
export type WorkerToken = { hash: string; workerId: string; env: Environment; createdAt: number; revokedAt: number | null }
export interface JobsTransaction {
  get(id: string): Promise<TaggingJob | null>
  list(): Promise<TaggingJob[]>
  review(batchId: string, plateId: string): Promise<{ fields: EditableFields; baselineVersion: number } | null>
  create(job: TaggingJob): void
  set(job: TaggingJob): void
}
export interface JobsStore {
  env: Environment
  transaction<T>(run: (transaction: JobsTransaction) => Promise<T>): Promise<T>
  getToken(hash: string): Promise<WorkerToken | null>
  createToken(token: WorkerToken): Promise<void>
  revokeToken(hash: string, at: number): Promise<void>
}
export type JobsDeps = { store: JobsStore; baseline(plateId: string): Promise<Plate | null>; baselineAtVersion?(version: number, plateId: string): Promise<Plate | null>; now(): number; id(): string; leaseMs: number; localScope?: string }
export type JobsError = 'not_found' | 'already_exists' | 'claim_expired' | 'claim_mismatch' | 'stale_input' | 'result_mismatch' | 'invalid_result' | 'forbidden'
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: JobsError }
