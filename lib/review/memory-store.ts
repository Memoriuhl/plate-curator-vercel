import { currentDraftChanges, draftChange, reviewChanges, type DraftChange, type ReviewCheckpoint } from './checkpoint'
import type { ProposedEdit, ReviewBatch, ReviewStore } from './types'

export function createMemoryStore(seed: (Omit<ReviewBatch, 'createdByName' | 'stateOrders'> & { createdByName?: string | null; stateOrders?: Record<string, string[]> })[], head: () => number = () => 1): ReviewStore & { signalRevision(batchId: string): number | null } {
  const batches = new Map(seed.map(batch => [batch.id, structuredClone({ ...batch, createdByName: batch.createdByName ?? null, stateOrders: batch.stateOrders ?? {} })]))
  const signals = new Map(seed.map(batch => [batch.id, batch.revision]))
  const edits = new Map<string, Map<string, ProposedEdit>>()

  const checkpoints = new Map<string, Map<string, ReviewCheckpoint>>()
  const changes = new Map<string, DraftChange[]>()

  const recentChanges = (batch: ReviewBatch, since: number) => currentDraftChanges(batch, [...edits.get(batch.id)?.keys() ?? []], (changes.get(batch.id) ?? []).filter(change => change.revision > since))

  return {
    async recentPlateIds(batchId, since) {
      const batch = batches.get(batchId)
      return batch ? [...new Set(recentChanges(batch, since).flatMap(change => change.plateIds))] : null
    },
    async markViewed(batchId, uid, revision, viewedAt) {
      const batch = batches.get(batchId)
      if (!batch || revision > batch.revision) return false
      const viewers = checkpoints.get(batchId) ?? new Map()
      if ((viewers.get(uid)?.revision ?? -1) < revision) viewers.set(uid, { revision, viewedAt })
      checkpoints.set(batchId, viewers)
      return true
    },
    async changesSinceReview(batchId, uid, revision) {
      const batch = batches.get(batchId)
      if (batch?.revision !== revision) return null
      const current = checkpoints.get(batchId)?.get(uid) ?? null
      return reviewChanges(revision, current, current ? recentChanges(batch, current.revision) : [])
    },
    async updatePublishMetadata(batchId, revision, fields) {
      const batch = batches.get(batchId)
      if (!batch || batch.revision !== revision) return false
      Object.assign(batch, structuredClone(fields))
      return true
    },
    async copy(input) {
      const existing = batches.get(input.batch.id)
      if (existing) return { ok: true, value: structuredClone(existing) }
      const source = batches.get(input.sourceId)
      if (!source) return { ok: false, error: 'not_found' }
      if (source.revision !== input.sourceRevision) return { ok: false, error: 'superseded_revision' }
      if (source.state !== 'approved') return { ok: false, error: 'invalid_state' }
      const liveVersion = head()
      if (liveVersion !== input.targetVersion) return { ok: false, error: 'head_moved', liveVersion }
      batches.set(input.batch.id, structuredClone(input.batch))
      edits.set(input.batch.id, new Map(input.edits.map(edit => [edit.plateId, structuredClone(edit)])))
      signals.set(input.batch.id, input.batch.revision)
      return { ok: true, value: structuredClone(input.batch) }
    },
    signalRevision: batchId => signals.get(batchId) ?? null,
    async create(batch) {
      if (batches.has(batch.id)) return 'exists'
      batches.set(batch.id, structuredClone(batch))
      signals.set(batch.id, batch.revision)
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
    async readBatch(batchId) {
      const batch = batches.get(batchId)
      return batch ? structuredClone({ batch, edits: [...edits.get(batchId)?.values() ?? []] }) : null
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
    async requestPublish(batchId, revision, at, requestedBy) {
      const batch = batches.get(batchId)
      if (!batch || batch.state !== 'approved' || batch.revision !== revision) return false
      batch.publishRequestedAt = at
      if (requestedBy) batch.publishRequestedBy = structuredClone(requestedBy)
      return true
    },
    async commit(batchId, expectedRevision, next) {
      if (batches.get(batchId)?.revision !== expectedRevision) return 'revision_mismatch'
      const saved = structuredClone(next)
      const current = batches.get(batchId)!
      if (current.publishAbandonment) saved.batch.publishAbandonment = structuredClone(current.publishAbandonment)
      if (current.approvalRun) saved.batch.approvalRun = structuredClone(current.approvalRun)
      if (current.publishRequestedAt && ['approved', 'published'].includes(saved.batch.state)) { saved.batch.publishRequestedAt = current.publishRequestedAt; if (current.publishRequestedBy) saved.batch.publishRequestedBy = structuredClone(current.publishRequestedBy) }
      const batchEdits = edits.get(batchId) ?? new Map<string, ProposedEdit>()
      if (saved.deleteEditFor !== undefined) batchEdits.delete(saved.deleteEditFor)
      for (const id of saved.deleteEditsFor ?? []) batchEdits.delete(id)
      const updates = [...(saved.edits ?? []), ...(saved.edit ? [saved.edit] : [])]
      const deletes = [...(saved.deleteEditsFor ?? []), ...(saved.deleteEditFor ? [saved.deleteEditFor] : [])]
      const change = draftChange(current, saved.batch, updates, deletes, saved.by)
      if (change) changes.set(batchId, [...(changes.get(batchId) ?? []), change])
      for (const edit of updates) batchEdits.set(edit.plateId, edit)
      edits.set(batchId, batchEdits)
      batches.set(batchId, saved.batch)
      signals.set(batchId, saved.batch.revision)
      return 'ok'
    },
  }
}
