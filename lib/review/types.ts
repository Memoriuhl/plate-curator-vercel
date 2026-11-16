import type { Plate } from '../catalog/types'

export type Role = 'editor' | 'owner'
export type Actor = { uid: string; role: Role }
export type BatchState = 'open' | 'submitted' | 'approved' | 'published' | 'conflict'
export type ReviewBatch = {
  id: string
  name: string
  createdBy: string
  createdAt: string
  state: BatchState
  revision: number
  baselineVersion: number
  plateIds: string[]
  approval: { revision: number; by: string; at: string } | null
}
export type EditableFields = Partial<Pick<Plate, 'tags' | 'templateFamily' | 'templateRole' | 'variantOfPlateId' | 'isStandard'>>
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
  commit(batchId: string, expectedRevision: number, next: { batch: ReviewBatch; edit?: ProposedEdit; deleteEditFor?: string }): Promise<'ok' | 'revision_mismatch'>
}
export type ReviewDeps = {
  store: ReviewStore
  baseline(plateId: string): Promise<Plate | null>
  now(): string
}
