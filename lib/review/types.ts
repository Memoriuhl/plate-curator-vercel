import type { Plate } from '../catalog/types'

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
  publishRequestedAt?: string | null
  approval: { revision: number; by: string; at: string } | null
}
export type EditableFields = Partial<Pick<Plate, 'tags' | 'templateFamily' | 'templateRole' | 'isStandard' | 'description'>> & { variantOfPlateId?: string | null }
export type ProposedEdit = {
  plateId: string
  baseRevision: string
  fields: EditableFields
  authorId: string
  updatedAt: string
  resultRevision: string
}
export type ReviewError = 'forbidden' | 'not_found' | 'stale_plate' | 'superseded_revision' | 'invalid_state'
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: ReviewError; current?: Plate }
export interface ReviewStore {
  create(batch: ReviewBatch): Promise<'ok' | 'exists'>
  list(filter: { states?: BatchState[] }): Promise<ReviewBatch[]>
  listEdits(batchId: string): Promise<ProposedEdit[]>
  getBatch(id: string): Promise<ReviewBatch | null>
  getEdit(batchId: string, plateId: string): Promise<ProposedEdit | null>
  recordRun(batchId: string, revision: number, runId: string): Promise<boolean>
  requestPublish(batchId: string, revision: number, at: string): Promise<boolean>
  commit(batchId: string, expectedRevision: number, next: { batch: ReviewBatch; edit?: ProposedEdit; deleteEditFor?: string; publishToken?: string }): Promise<'ok' | 'revision_mismatch'>
}
export type ReviewDeps = {
  store: ReviewStore
  baseline(plateId: string): Promise<Plate | null>
  baselineAtVersion(version: number, plateId: string): Promise<Plate | null>
  stateBaseline(version: number, state: string, order?: 'snapshot'): Promise<Plate[]>
  supersedeRun?(batch: ReviewBatch): Promise<void>
  now(): string
}
