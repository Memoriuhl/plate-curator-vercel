import { canCopyForFreshReview } from './access'
import {
  changeBefore,
  currentDraftChanges,
  draftChange,
  reviewChanges,
  type DraftChange,
  type ReviewCheckpoint,
} from './draft/checkpoint'
import { retryDraft, retryDraftRace } from './preconditions'
import { nextPlateEditVersions, recordEditAuthors } from './edit-history'
import type {
  ProposedEdit,
  ReviewBatch,
  ReviewStore,
  StateMoveResult,
} from './types'

/**
 * Create an in-memory review adapter that supports revision checks, checkpoints and
 * publish metadata for fixtures.
 */
export function createMemoryStore(
  seed: (Omit<ReviewBatch, 'createdByName' | 'stateOrders'> & {
    createdByName?: string | null
    stateOrders?: Record<string, string[]>
  })[],
  head: () => number = () => 1
): ReviewStore & { signalRevision(batchId: string): number | null } {
  const batches = new Map(
    seed.map((batch) => [
      batch.id,
      structuredClone({
        ...batch,
        createdByName: batch.createdByName ?? null,
        stateOrders: batch.stateOrders ?? {},
      }),
    ])
  )
  const signals = new Map(seed.map((batch) => [batch.id, batch.revision]))
  const edits = new Map<string, Map<string, ProposedEdit>>()

  const checkpoints = new Map<string, Map<string, ReviewCheckpoint>>()
  const changes = new Map<string, DraftChange[]>()
  const moveReceipts = new Map<
    string,
    { fingerprint: string; result: StateMoveResult }
  >()

  /**
   * Read draft changes after a revision and retain only changes still present in the
   * draft.
   */
  const recentChanges = (batch: ReviewBatch, since: number) =>
    currentDraftChanges(
      batch,
      [...(edits.get(batch.id)?.values() ?? [])]
        .filter((edit) => Object.keys(edit.fields).length > 0)
        .map((edit) => edit.plateId),
      (changes.get(batch.id) ?? []).filter((change) => change.revision > since)
    )

  return {
    async transactStateMove(batchId, operationId, fingerprint, plan) {
      const key = JSON.stringify([batchId, operationId])
      return retryDraftRace(async () => {
        const receipt = moveReceipts.get(key)
        if (receipt)
          return receipt.fingerprint === fingerprint
            ? { ok: true, value: structuredClone(receipt.result) }
            : { ok: false, error: 'superseded_revision' }
        const detail = await this.readBatch(batchId)
        if (!detail) return { ok: false, error: 'not_found' }
        const proposed = await plan(detail)
        if (
          moveReceipts.has(key) ||
          batches.get(batchId)?.revision !== detail.batch.revision
        )
          return retryDraft
        if (!proposed.ok) return proposed
        if (proposed.mutation) {
          const saved = await this.commit(
            batchId,
            detail.batch.revision,
            proposed.mutation
          )
          if (saved === 'revision_mismatch') return retryDraft
          if (saved !== 'ok') return { ok: false, error: saved }
        }
        moveReceipts.set(key, {
          fingerprint,
          result: structuredClone(proposed.value),
        })
        return { ok: true, value: proposed.value }
      })
    },
    /** Return the distinct active draft plate IDs changed after a given revision. */
    async recentPlateIds(batchId, since) {
      const batch = batches.get(batchId)
      return batch
        ? [
            ...new Set(
              recentChanges(batch, since).flatMap((change) => change.plateIds)
            ),
          ]
        : null
    },
    /**
     * Save the viewer's reviewed revision after checking that it belongs to the batch.
     */
    async markViewed(batchId, uid, revision, viewedAt) {
      const batch = batches.get(batchId)
      if (!batch || revision > batch.revision) return false
      const viewers = checkpoints.get(batchId) ?? new Map()
      if ((viewers.get(uid)?.revision ?? -1) < revision)
        viewers.set(uid, { revision, viewedAt })
      checkpoints.set(batchId, viewers)
      return true
    },
    /** Calculate current draft changes since the actor last reviewed the batch. */
    async changesSinceReview(batchId, uid, revision) {
      const batch = batches.get(batchId)
      if (batch?.revision !== revision) return null
      const current = checkpoints.get(batchId)?.get(uid) ?? null
      return reviewChanges(
        revision,
        current,
        current ? recentChanges(batch, current.revision) : []
      )
    },
    /** Apply a metadata-only publish update when the batch exists. */
    async updatePublishMetadata(batchId, revision, fields) {
      const batch = batches.get(batchId)
      if (!batch || batch.revision !== revision) return false
      Object.assign(batch, structuredClone(fields))
      return true
    },
    /**
     * Create a copied draft while applying the same baseline and idempotency checks as
     * the persistent store.
     */
    async copy(input) {
      const existing = batches.get(input.batch.id)
      if (existing) return { ok: true, value: structuredClone(existing) }
      const source = batches.get(input.sourceId)
      if (!source) return { ok: false, error: 'not_found' }
      if (source.revision !== input.sourceRevision)
        return { ok: false, error: 'superseded_revision' }
      if (!canCopyForFreshReview(source, input.targetVersion))
        return { ok: false, error: 'invalid_state' }
      const liveVersion = head()
      if (liveVersion !== input.targetVersion)
        return { ok: false, error: 'head_moved', liveVersion }
      batches.set(input.batch.id, structuredClone(input.batch))
      edits.set(
        input.batch.id,
        new Map(
          input.edits.map((edit) => [edit.plateId, structuredClone(edit)])
        )
      )
      signals.set(input.batch.id, input.batch.revision)
      return { ok: true, value: structuredClone(input.batch) }
    },
    /** List change-log entries after a revision, oldest first. */
    async listChanges(batchId, after) {
      return structuredClone(
        (changes.get(batchId) ?? [])
          .filter((change) => change.revision > after)
          .sort((left, right) => left.revision - right.revision)
      )
    },
    /** Drop change-log entries at or below a revision; return how many went. */
    async pruneChanges(batchId, through) {
      const kept = (changes.get(batchId) ?? []).filter(
        (change) => change.revision > through
      )
      const removed = (changes.get(batchId)?.length ?? 0) - kept.length
      changes.set(batchId, kept)
      return removed
    },
    /** Expose the latest live signal revision recorded for the batch. */
    signalRevision: (batchId) => signals.get(batchId) ?? null,
    /** Create a new batch and initialize its signal while rejecting an existing ID. */
    async create(batch, initialEdits) {
      if (batches.has(batch.id)) return 'exists'
      batches.set(batch.id, structuredClone(batch))
      if (initialEdits?.length)
        edits.set(
          batch.id,
          new Map(
            initialEdits.map((edit) => [edit.plateId, structuredClone(edit)])
          )
        )
      signals.set(batch.id, batch.revision)
      return 'ok'
    },
    /** List matching batch summaries and clone them to protect stored state. */
    async list(filter) {
      return structuredClone(
        [...batches.values()]
          .filter(
            (batch) =>
              filter.states === undefined || filter.states.includes(batch.state)
          )
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      )
    },
    /** Return a snapshot of the current edits for the batch. */
    async listEdits(batchId) {
      return structuredClone([...(edits.get(batchId)?.values() ?? [])])
    },
    /** Read the batch and all its edits together as a detached snapshot. */
    async readBatch(batchId, jurisdictions) {
      const batch = batches.get(batchId)
      return batch
        ? structuredClone({
            batch,
            edits: [...(edits.get(batchId)?.values() ?? [])].filter(
              (edit) =>
                !jurisdictions || jurisdictions.has(edit.plateId.split('.')[0])
            ),
          })
        : null
    },
    /** Return a copy of the requested batch so callers can edit it locally. */
    async getBatch(id) {
      return structuredClone(batches.get(id) ?? null)
    },
    /** Return a copy of the current proposed edit for the plate. */
    async getEdit(batchId, plateId) {
      return structuredClone(edits.get(batchId)?.get(plateId) ?? null)
    },
    /** Attach an approval run while its requested batch revision is still current. */
    async recordRun(batchId, revision, runId) {
      const batch = batches.get(batchId)
      if (
        !batch ||
        !(
          (batch.state === 'submitted' && batch.revision === revision) ||
          (batch.state === 'approved' && batch.approval?.revision === revision)
        )
      )
        return false
      batch.approvalRun = { runId, revision }
      return true
    },
    /**
     * Save confirmed publish request metadata while the expected batch revision still
     * matches.
     */
    async requestPublish(batchId, revision, at, requestedBy) {
      const batch = batches.get(batchId)
      if (!batch || batch.state !== 'approved' || batch.revision !== revision)
        return false
      batch.publishRequestedAt = at
      if (requestedBy) batch.publishRequestedBy = structuredClone(requestedBy)
      return true
    },
    /**
     * Commit edits and signal the new batch revision after enforcing optimistic
     * concurrency.
     */
    async commit(batchId, expectedRevision, next) {
      if (batches.get(batchId)?.revision !== expectedRevision)
        return 'revision_mismatch'
      const saved = structuredClone(next)
      const current = batches.get(batchId)!
      if (current.publishAbandonment)
        saved.batch.publishAbandonment = structuredClone(
          current.publishAbandonment
        )
      if (current.approvalRun)
        saved.batch.approvalRun = structuredClone(current.approvalRun)
      if (
        current.publishRequestedAt &&
        ['approved', 'published'].includes(saved.batch.state)
      ) {
        saved.batch.publishRequestedAt = current.publishRequestedAt
        if (current.publishRequestedBy)
          saved.batch.publishRequestedBy = structuredClone(
            current.publishRequestedBy
          )
      }
      const batchEdits = edits.get(batchId) ?? new Map<string, ProposedEdit>()
      let updates = [
        ...(saved.edits ?? []),
        ...(saved.edit ? [saved.edit] : []),
      ]
      const deletes = [
        ...(saved.deleteEditsFor ?? []),
        ...(saved.deleteEditFor ? [saved.deleteEditFor] : []),
      ]
      const touched = [...updates.map((edit) => edit.plateId), ...deletes]
      if (saved.batch.kind === 'shared-draft') {
        const versions = nextPlateEditVersions(
          current,
          saved.batch.revision,
          saved.history === false ? [] : touched
        )
        if (versions) saved.batch.plateEditVersions = versions
        updates = updates.map((edit) => ({
          ...(saved.history === false
            ? edit
            : recordEditAuthors(edit, batchEdits.get(edit.plateId))),
          revision: saved.batch.revision,
        }))
      }
      const change =
        saved.history === false
          ? null
          : draftChange(
              current,
              saved.batch,
              updates,
              deletes,
              saved.by,
              saved.batch.kind === 'shared-draft'
                ? changeBefore(
                    current,
                    saved.batch,
                    new Map(
                      touched.map((id) => [
                        id,
                        structuredClone(batchEdits.get(id) ?? null),
                      ])
                    )
                  )
                : undefined
            )
      if (change)
        changes.set(batchId, [...(changes.get(batchId) ?? []), change])
      for (const id of deletes) batchEdits.delete(id)
      for (const edit of updates) batchEdits.set(edit.plateId, edit)
      edits.set(batchId, batchEdits)
      batches.set(batchId, saved.batch)
      signals.set(batchId, saved.batch.revision)
      return 'ok'
    },
  }
}
