import type { Abandonment, RequesterAuthority } from '../publish/types'
import type { Plate, StoryFields } from '../catalog/types'

export type Role = 'editor' | 'owner'
export type Actor = { uid: string; name: string | null; role: Role }
export type BatchState = 'open' | 'submitted' | 'approved' | 'published' | 'conflict'
export type ReviewBatch = {
  id: string
  name: string
  createdByName: string | null
  createdBy: string
  createdAt: string
  state: BatchState
  revision: number
  baselineVersion: number
  stateOrders: Record<string, string[]>
  baselineOrders?: Record<string, string[]>
  plateIds: string[]
  approvalRun?: { runId: string; revision: number }
  publishAbandonment?: Abandonment
  publishCommand?: { commandId: string; revision: number }
  publishRequestedBy?: RequesterAuthority | null
  publishRequestedAt?: string | null
  approval: { revision: number; by: string; at: string } | null
  source?: { batchId: string; revision: number }
  pipelineApplications?: Record<string, { by: string; at: string }>
}
export type EditableFields = Partial<Pick<Plate, 'tags' | 'templateFamily' | 'templateRole' | 'isStandard' | 'description' | 'colorDetail' | 'lineageColor'>> & StoryFields & { imageUrl?: string | null; sourceUrl?: string | null; variantOfPlateId?: string | null; deleted?: boolean }
export type ProposedEdit = {
  plateId: string
  baseRevision: string
  fields: EditableFields
  authorId: string
  updatedAt: string
  resultRevision: string
}
export type StandardChange = { from: string | null; to: string }
export type ReviewError = 'standard_change_unconfirmed' | 'standard_required' | 'standard_invalid_template' | 'forbidden' | 'not_found' | 'stale_plate' | 'superseded_revision' | 'invalid_state'
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: ReviewError; current?: Plate; reasons?: string[] }
export interface ReviewStore {
  updatePublishMetadata(batchId: string, revision: number, fields: PublishMetadata): Promise<boolean>
  copy(input: { sourceId: string; sourceRevision: number; targetVersion: number; batch: ReviewBatch; edits: ProposedEdit[] }): Promise<CopyCommitResult>
  create(batch: ReviewBatch): Promise<'ok' | 'exists'>
  list(filter: { states?: BatchState[] }): Promise<ReviewBatch[]>
  listEdits(batchId: string): Promise<ProposedEdit[]>
  readBatch(batchId: string): Promise<{ batch: ReviewBatch; edits: ProposedEdit[] } | null>
  getBatch(id: string): Promise<ReviewBatch | null>
  getEdit(batchId: string, plateId: string): Promise<ProposedEdit | null>
  recordRun(batchId: string, revision: number, runId: string): Promise<boolean>
  requestPublish(batchId: string, revision: number, at: string, requestedBy?: RequesterAuthority): Promise<boolean>
  commit(batchId: string, expectedRevision: number, next: { batch: ReviewBatch; edit?: ProposedEdit; edits?: ProposedEdit[]; deleteEditsFor?: string[]; deleteEditFor?: string; publishToken?: string }): Promise<'ok' | 'revision_mismatch'>
}
export type PublishMetadata = Partial<Pick<ReviewBatch, 'publishAbandonment' | 'publishCommand' | 'approvalRun' | 'publishRequestedAt' | 'publishRequestedBy'>>
export type CopyCommitResult = { ok: true; value: ReviewBatch } | { ok: false; error: 'not_found' | 'superseded_revision' | 'invalid_state' | 'head_moved'; liveVersion?: number }
export type ReviewDeps = {
  store: ReviewStore
  baseline(plateId: string): Promise<Plate | null>
  baselineAtVersion(version: number, plateId: string): Promise<Plate | null>
  stateBaseline(version: number, state: string, order?: 'snapshot'): Promise<Plate[]>
  supersedeRun?(batch: ReviewBatch): Promise<void>
  now(): string
}
