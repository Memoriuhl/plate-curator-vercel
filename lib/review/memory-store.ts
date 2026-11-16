import type { ProposedEdit, ReviewBatch, ReviewStore } from './types'

export function createMemoryStore(seed: ReviewBatch[]): ReviewStore {
  const batches = new Map(seed.map(batch => [batch.id, structuredClone(batch)]))
  const edits = new Map<string, Map<string, ProposedEdit>>()

  return {
    async getBatch(id) {
      return structuredClone(batches.get(id) ?? null)
    },
    async getEdit(batchId, plateId) {
      return structuredClone(edits.get(batchId)?.get(plateId) ?? null)
    },
    async commit(batchId, expectedRevision, next) {
      if (batches.get(batchId)?.revision !== expectedRevision) return 'revision_mismatch'
      const saved = structuredClone(next)
      const batchEdits = edits.get(batchId) ?? new Map<string, ProposedEdit>()
      if (saved.deleteEditFor !== undefined) batchEdits.delete(saved.deleteEditFor)
      if (saved.edit) batchEdits.set(saved.edit.plateId, saved.edit)
      edits.set(batchId, batchEdits)
      batches.set(batchId, saved.batch)
      return 'ok'
    },
  }
}
