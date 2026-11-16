import type { ProposedEdit, ReviewBatch, ReviewStore } from './types'

export function createMemoryStore(seed: (Omit<ReviewBatch, 'createdByName' | 'stateOrders'> & { createdByName?: string | null; stateOrders?: Record<string, string[]> })[]): ReviewStore {
  const batches = new Map(seed.map(batch => [batch.id, structuredClone({ ...batch, createdByName: batch.createdByName ?? null, stateOrders: batch.stateOrders ?? {} })]))
  const edits = new Map<string, Map<string, ProposedEdit>>()

  return {
    async create(batch) {
      if (batches.has(batch.id)) return 'exists'
      batches.set(batch.id, structuredClone(batch))
      return 'ok'
    },
    async list(filter) {
      return structuredClone([...batches.values()]
        .filter(batch => filter.states === undefined || filter.states.includes(batch.state))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)))
    },
    async listEdits(batchId) {
      return structuredClone([...edits.get(batchId)?.values() ?? []])
    },
    async getBatch(id) {
      return structuredClone(batches.get(id) ?? null)
    },
    async getEdit(batchId, plateId) {
      return structuredClone(edits.get(batchId)?.get(plateId) ?? null)
    },
    async recordRun(batchId, revision, runId) {
      const batch = batches.get(batchId)
      if (!batch || !(batch.state === 'submitted' && batch.revision === revision || batch.state === 'approved' && batch.approval?.revision === revision)) return false
      batch.approvalRun = { runId, revision }
      return true
    },
    async requestPublish(batchId, revision, at) {
      const batch = batches.get(batchId)
      if (!batch || batch.state !== 'approved' || batch.revision !== revision) return false
      batch.publishRequestedAt = at
      return true
    },
    async commit(batchId, expectedRevision, next) {
      if (batches.get(batchId)?.revision !== expectedRevision) return 'revision_mismatch'
      const saved = structuredClone(next)
      const current = batches.get(batchId)!
      if (current.approvalRun) saved.batch.approvalRun = structuredClone(current.approvalRun)
      if (current.publishRequestedAt && ['approved', 'published'].includes(saved.batch.state)) saved.batch.publishRequestedAt = current.publishRequestedAt
      const batchEdits = edits.get(batchId) ?? new Map<string, ProposedEdit>()
      if (saved.deleteEditFor !== undefined) batchEdits.delete(saved.deleteEditFor)
      if (saved.edit) batchEdits.set(saved.edit.plateId, saved.edit)
      edits.set(batchId, batchEdits)
      batches.set(batchId, saved.batch)
      return 'ok'
    },
  }
}
