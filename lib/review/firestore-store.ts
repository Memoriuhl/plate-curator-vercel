import { canCopyForFreshReview } from './access'
import {
  FieldPath,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
  type ReadWriteTransactionOptions,
} from '@google-cloud/firestore'
import { signalChange } from '../live/change-signals'
import { draftTopic } from '../live/topics'
import { liveEnvKey, signalPath } from './signals/live-signal'
import type {
  ProposedEdit,
  PublishMetadata,
  ReviewBatch,
  ReviewStore,
  StateMoveResult,
} from './types'
import {
  changeBefore,
  currentDraftChanges,
  draftChange,
  reviewChanges,
  type DraftChange,
  type ReviewCheckpoint,
} from './draft/checkpoint'
import { receiptId } from '../publish/command'
import { nextPlateEditVersions, recordEditAuthors } from './edit-history'

/** Locate the shared transaction state for deletion undo and Publish acceptance. */
export const deletionPublishFenceRef = (db: Firestore, batchId: string) =>
  db.doc(`reviewBatches/${batchId}/coordination/deletionPublish`)

/** Stage a metadata-only update that preserves the batch's editorial revision. */
export function writePublishMetadata(
  transaction: Transaction,
  batch: DocumentSnapshot,
  fields: PublishMetadata
) {
  transaction.update(batch.ref, fields)
}

type TouchStates = (states: Iterable<string>) => void

/** Collect draft signals from the successful attempt and dispatch after the outer commit. */
export function reviewTransaction(db: Firestore, env: string) {
  return async function transact<T>(
    run: (transaction: Transaction, touchStates: TouchStates) => Promise<T>,
    options?: ReadWriteTransactionOptions
  ): Promise<T> {
    const { result, states } = await db.runTransaction(async (transaction) => {
      const states = new Set<string>()
      const result = await run(transaction, (touched) => {
        for (const state of touched) states.add(state)
      })
      return { result, states }
    }, options)
    for (const state of states)
      if (/^[A-Z]{2}$/.test(state)) signalChange(db, env, draftTopic(state))
    return result
  }
}

/**
 * Build the Firestore review adapter for a specific environment and optional existing
 * transaction.
 */
export function firestoreReviewStore(
  db: Firestore,
  env: string,
  scopedTransaction?: Transaction,
  scopedTouchStates?: TouchStates
): ReviewStore {
  const batches = db.collection('reviewBatches')
  const transact = reviewTransaction(db, env)
  /** Locate the live revision signal that clients watch for changes to this batch. */
  const signal = (batchId: string) =>
    db.doc(signalPath(liveEnvKey(env), batchId))
  /** Stage creation of a batch and its initial live revision signal together. */
  const create = (
    transaction: Transaction,
    batch: ReviewBatch,
    edits: ProposedEdit[] = []
  ) => {
    transaction.create(batches.doc(batch.id), { ...batch, env })
    transaction.set(signal(batch.id), { revision: batch.revision })
    for (const edit of edits)
      transaction.set(
        batches.doc(batch.id).collection('edits').doc(edit.plateId),
        edit
      )
  }

  /**
   * Read draft changes and current edits together so the checkpoint reflects current
   * draft content.
   */
  const recentChanges = async (
    transaction: Transaction,
    batch: DocumentSnapshot,
    since: number
  ) => {
    const [changes, edits] = await Promise.all([
      transaction.get(
        batch.ref.collection('draftChanges').where('revision', '>', since)
      ),
      transaction.get(batch.ref.collection('edits').select('fields')),
    ])
    return currentDraftChanges(
      batch.data() as ReviewBatch,
      edits.docs
        .filter((edit) => Object.keys(edit.get('fields') ?? {}).length > 0)
        .map((edit) => edit.id),
      changes.docs.map((doc) => doc.data() as DraftChange)
    )
  }

  return {
    async transactStateMove(batchId, operationId, fingerprint, plan, prepare) {
      const batchRef = batches.doc(batchId)
      const receiptRef = batchRef
        .collection('stateMoveReceipts')
        .doc(operationId)
      const replay = (receipt: DocumentSnapshot) =>
        receipt.get('fingerprint') === fingerprint
          ? {
              ok: true as const,
              value: receipt.get('result') as StateMoveResult,
            }
          : { ok: false as const, error: 'superseded_revision' as const }
      // Load immutable catalog data before locking the draft. The transaction
      // still reads the current revision and handles a rebase during loading.
      const [head, previous] = await db.getAll(batchRef, receiptRef)
      if (head.get('env') !== env) return { ok: false, error: 'not_found' }
      if (previous.exists) return replay(previous)
      await prepare(head.get('baselineVersion'))
      try {
        return await transact(
          async (transaction, touchStates) => {
            const scoped = firestoreReviewStore(
              db,
              env,
              transaction,
              touchStates
            )
            const detail = await scoped.readBatch(batchId)
            if (!detail) return { ok: false, error: 'not_found' }
            const receipt = await transaction.get(receiptRef)
            if (receipt.exists) return replay(receipt)
            const proposed = await plan(detail)
            if (!proposed.ok) return proposed
            if (proposed.mutation) {
              const saved = await scoped.commit(
                batchId,
                detail.batch.revision,
                proposed.mutation
              )
              if (saved !== 'ok')
                return {
                  ok: false,
                  error:
                    saved === 'revision_mismatch'
                      ? 'superseded_revision'
                      : saved,
                }
            }
            transaction.create(receiptRef, {
              fingerprint,
              result: proposed.value,
            })
            return { ok: true, value: proposed.value }
          },
          { maxAttempts: 5 }
        )
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 10)
          return { ok: false, error: 'superseded_revision' }
        throw error
      }
    },
    /** List the distinct plate IDs still changed since a particular batch revision. */
    async recentPlateIds(batchId, since) {
      return db.runTransaction(
        async (transaction) => {
          const batch = await transaction.get(batches.doc(batchId))
          if (batch.get('env') !== env) return null
          return [
            ...new Set(
              (await recentChanges(transaction, batch, since)).flatMap(
                (change) => change.plateIds
              )
            ),
          ]
        },
        { readOnly: true }
      )
    },
    /**
     * Save a viewer's checkpoint after confirming the batch and viewed revision are
     * valid.
     */
    async markViewed(batchId, uid, revision, viewedAt) {
      return db.runTransaction(async (transaction) => {
        const batch = batches.doc(batchId)
        const ref = batch
          .collection('reviewCheckpoints')
          .doc(encodeURIComponent(uid))
        const [current, checkpoint] = await transaction.getAll(batch, ref)
        if (current.get('env') !== env || revision > current.get('revision'))
          return false
        if ((checkpoint.get('revision') ?? -1) < revision)
          transaction.set(ref, { revision, viewedAt })
        return true
      })
    },
    /**
     * Load the viewer's checkpoint and summarize current changes in one consistent read.
     */
    async changesSinceReview(batchId, uid, revision) {
      return db.runTransaction(
        async (transaction) => {
          const ref = batches.doc(batchId)
          const [batch, checkpoint] = await transaction.getAll(
            ref,
            ref.collection('reviewCheckpoints').doc(encodeURIComponent(uid))
          )
          if (batch.get('env') !== env || batch.get('revision') !== revision)
            return null
          const current = checkpoint.exists
            ? (checkpoint.data() as ReviewCheckpoint)
            : null
          if (!current || current.revision >= revision)
            return reviewChanges(revision, current, [])
          return reviewChanges(
            revision,
            current,
            await recentChanges(transaction, batch, current.revision)
          )
        },
        { readOnly: true }
      )
    },
    /**
     * Update publish metadata within the existing transaction or start one for a
     * standalone call.
     */
    async updatePublishMetadata(batchId, revision, fields) {
      /** Apply metadata only to a batch in the store's environment. */
      const write = async (transaction: Transaction) => {
        const batch = await transaction.get(batches.doc(batchId))
        if (batch.get('env') !== env || batch.get('revision') !== revision)
          return false
        writePublishMetadata(transaction, batch, fields)
        return true
      }
      return scopedTransaction
        ? write(scopedTransaction)
        : db.runTransaction(write)
    },
    /**
     * Create and populate a copied batch after checking that the live catalog still
     * matches its baseline.
     */
    async copy(input) {
      return db.runTransaction(async (transaction) => {
        const sourceRef = batches.doc(input.sourceId)
        const targetRef = batches.doc(input.batch.id)
        const [source, target, head, receipt] = await transaction.getAll(
          sourceRef,
          targetRef,
          db.doc('config/catalog'),
          db.doc(
            `publishRecords/${receiptId(input.sourceId, input.sourceRevision)}`
          )
        )
        if (target.exists) {
          if (target.get('env') !== env)
            return { ok: false, error: 'not_found' }
          const value = target.data()!
          delete value.env
          delete value.publishReservation
          return { ok: true, value: value as ReviewBatch }
        }
        if (!source.exists || source.get('env') !== env)
          return { ok: false, error: 'not_found' }
        if (source.get('revision') !== input.sourceRevision)
          return { ok: false, error: 'superseded_revision' }
        if (
          !canCopyForFreshReview(
            {
              state: source.get('state'),
              baselineVersion: source.get('baselineVersion'),
            },
            input.targetVersion
          )
        )
          return { ok: false, error: 'invalid_state' }
        if (source.get('publishReservation') || receipt.get('committedAt'))
          return { ok: false, error: 'invalid_state' }
        const liveVersion = head.get('version')
        if (typeof liveVersion !== 'number')
          throw new Error('Catalog head unavailable')
        if (liveVersion !== input.targetVersion)
          return { ok: false, error: 'head_moved', liveVersion }
        create(transaction, input.batch)
        for (const edit of input.edits)
          transaction.create(
            targetRef.collection('edits').doc(edit.plateId),
            edit
          )
        return { ok: true, value: input.batch }
      })
    },
    /**
     * Create a batch with its live signal and return an existing-ID outcome when
     * retried.
     */
    async create(batch, edits) {
      try {
        await db.runTransaction(async (transaction) => {
          create(transaction, batch, edits)
        })
        return 'ok'
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 6)
          return 'exists'
        throw error
      }
    },
    /**
     * List batches in this environment using the requested state and ordering filters.
     */
    async list(filter) {
      if (filter.states?.length === 0) return []
      let query = batches.where('env', '==', env)
      if (filter.states !== undefined)
        query = query.where('state', 'in', [...new Set(filter.states)])
      const snapshot = await query.get()
      return snapshot.docs
        .map((doc) => {
          const batch = doc.data()
          delete batch.env
          delete batch.publishReservation
          return {
            ...batch,
            createdByName: batch.createdByName ?? null,
            stateOrders: batch.stateOrders ?? {},
          } as ReviewBatch
        })
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    },
    /** Read current edits using the ambient transaction when available. */
    async listEdits(batchId) {
      /**
       * Load edits only after verifying that their parent batch belongs to this
       * environment.
       */
      const run = async (transaction: Transaction) => {
        const batchRef = batches.doc(batchId)
        const batch = await transaction.get(batchRef)
        if (!batch.exists || batch.get('env') !== env) return []
        const edits = await transaction.get(batchRef.collection('edits'))
        return edits.docs.map((doc) => doc.data() as ProposedEdit)
      }
      return scopedTransaction
        ? run(scopedTransaction)
        : db.runTransaction(run, { readOnly: true })
    },
    /** Read a batch and its requested plate edits in a consistent transaction. */
    async readBatch(batchId, jurisdictions) {
      const run = async (transaction: Transaction) => {
        const ref = batches.doc(batchId)
        const snapshot = await transaction.get(ref)
        if (!snapshot.exists || snapshot.get('env') !== env) return null
        const edits = ref.collection('edits')
        // The range contains document IDs with the jurisdiction's `XX.` prefix.
        const rows = jurisdictions
          ? (
              await Promise.all(
                [...jurisdictions].map((state) =>
                  transaction.get(
                    edits
                      .where(FieldPath.documentId(), '>=', `${state}.`)
                      .where(FieldPath.documentId(), '<', `${state}0`)
                  )
                )
              )
            ).flatMap(({ docs }) => docs)
          : (await transaction.get(edits)).docs
        const batch = snapshot.data()!
        delete batch.env
        delete batch.publishReservation
        return {
          batch: {
            ...batch,
            createdByName: batch.createdByName ?? null,
            stateOrders: batch.stateOrders ?? {},
          } as ReviewBatch,
          edits: rows.map((doc) => doc.data() as ProposedEdit),
        }
      }
      return scopedTransaction
        ? run(scopedTransaction)
        : db.runTransaction(run, { readOnly: true })
    },
    /** List change-log entries after a revision, oldest first. */
    async listChanges(batchId, after) {
      const ref = batches.doc(batchId)
      const batch = await ref.get()
      if (batch.get('env') !== env) return []
      const snapshot = await ref
        .collection('draftChanges')
        .where('revision', '>', after)
        .orderBy('revision')
        .get()
      return snapshot.docs.map((doc) => doc.data() as DraftChange)
    },
    /**
     * Delete change-log entries at or below a revision in pages, so a long-lived draft
     * does not keep history it can no longer use.
     */
    async pruneChanges(batchId, through) {
      const ref = batches.doc(batchId)
      const batch = await ref.get()
      if (batch.get('env') !== env) return 0
      let removed = 0
      while (true) {
        const page = await ref
          .collection('draftChanges')
          .where('revision', '<=', through)
          .limit(400)
          .get()
        if (page.empty) return removed
        const writes = db.batch()
        for (const doc of page.docs) writes.delete(doc.ref)
        await writes.commit()
        removed += page.size
      }
    },
    /** Fetch a batch by ID within this environment and normalize missing state orders. */
    async getBatch(id) {
      const snapshot = scopedTransaction
        ? await scopedTransaction.get(batches.doc(id))
        : await batches.doc(id).get()
      const { env: storedEnv, ...batch } = snapshot.data() ?? {}
      delete batch.publishReservation
      return storedEnv === env
        ? ({
            ...batch,
            createdByName: batch.createdByName ?? null,
            stateOrders: batch.stateOrders ?? {},
          } as ReviewBatch)
        : null
    },
    /** Fetch one plate edit using the existing transaction or a consistent read. */
    async getEdit(batchId, plateId) {
      /** Check the parent batch's environment before loading its plate edit. */
      const run = async (transaction: Transaction) => {
        const batchRef = batches.doc(batchId)
        const batch = await transaction.get(batchRef)
        if (!batch.exists || batch.get('env') !== env) return null
        const edit = await transaction.get(
          batchRef.collection('edits').doc(plateId)
        )
        return edit.exists ? (edit.data() as ProposedEdit) : null
      }
      return scopedTransaction
        ? run(scopedTransaction)
        : db.runTransaction(run, { readOnly: true })
    },
    /**
     * Attach an approval workflow run while the batch still has the expected revision.
     */
    async recordRun(batchId, revision, runId) {
      return db.runTransaction(async (transaction) => {
        const ref = batches.doc(batchId)
        const batch = await transaction.get(ref)
        if (
          batch.get('env') !== env ||
          !(
            (batch.get('state') === 'submitted' &&
              batch.get('revision') === revision) ||
            (batch.get('state') === 'approved' &&
              batch.get('approval')?.revision === revision)
          )
        )
          return false
        transaction.update(ref, { approvalRun: { runId, revision } })
        return true
      })
    },
    /**
     * Record the owner and timestamp for a publish request at the expected batch
     * revision.
     */
    async requestPublish(batchId, revision, at, requestedBy) {
      return db.runTransaction(async (transaction) => {
        const ref = batches.doc(batchId)
        const batch = await transaction.get(ref)
        if (
          batch.get('env') !== env ||
          batch.get('state') !== 'approved' ||
          batch.get('revision') !== revision
        )
          return false
        transaction.update(ref, {
          publishRequestedAt: at,
          ...(requestedBy ? { publishRequestedBy: requestedBy } : {}),
        })
        return true
      })
    },
    async deletionPublishFence(batchId) {
      const ref = deletionPublishFenceRef(db, batchId)
      const record = await (scopedTransaction
        ? scopedTransaction.get(ref)
        : ref.get())
      return record.get('generation') ?? 0
    },
    /**
     * Commit a batch revision within the existing transaction or start a standalone
     * transaction.
     */
    async commit(batchId, expectedRevision, next) {
      /**
       * Check the expected revision and publish fences, then write the batch, edits and
       * live signal together.
       */
      const run = async (
        transaction: Transaction,
        touchStates?: TouchStates
      ) => {
        const batchRef = batches.doc(batchId)
        const batch = await transaction.get(batchRef)
        if (
          !batch.exists ||
          batch.get('env') !== env ||
          batch.get('revision') !== expectedRevision
        ) {
          return 'revision_mismatch'
        }
        if (next.deletionPublishFence !== undefined) {
          const fence = await transaction.get(
            deletionPublishFenceRef(db, batchId)
          )
          if ((fence.get('generation') ?? 0) !== next.deletionPublishFence)
            return 'revision_mismatch'
        }
        if (next.migrationHold) {
          const [hold, pointer] = await transaction.getAll(
            db.doc('locks/publish'),
            db.doc('config/catalog')
          )
          const version = pointer.get('version')
          if (
            hold.get('token') !== next.migrationHold.token ||
            hold.get('purpose') !== 'migration' ||
            !(Date.parse(hold.get('expiresAt')) > Date.now()) ||
            (typeof version === 'number' ? version : null) !==
              next.migrationHold.catalogVersion
          )
            return 'revision_mismatch'
        }
        if (batch.get('state') === 'open' && next.batch.state === 'submitted') {
          const runs = await transaction.get(
            db
              .collection('localPipelineRuns')
              .where('batchId', '==', batchId)
              .select('status')
          )
          if (
            runs.docs.some((run) =>
              ['queued', 'running'].includes(run.get('status'))
            )
          )
            return 'pipeline_busy'
        }
        const reservation = batch.get('publishReservation')
        if (reservation) {
          if (
            next.publishToken !== reservation.token ||
            next.batch.state !== 'published' ||
            next.batch.revision !== expectedRevision + 1
          )
            return 'revision_mismatch'
          const record = await transaction.get(
            db.doc(`publishRecords/${reservation.recordId}`)
          )
          if (
            !record.get('committedAt') ||
            record.get('state') !== 'done' ||
            record.get('env') !== env ||
            record.get('revision') !== expectedRevision ||
            record.get('batchId') !== batchId
          )
            return 'revision_mismatch'
        } else if (next.publishToken !== undefined) return 'revision_mismatch'
        const draft = next.batch.kind === 'shared-draft'
        let updates = [...(next.edits ?? []), ...(next.edit ? [next.edit] : [])]
        const deletes = [
          ...(next.deleteEditsFor ?? []),
          ...(next.deleteEditFor ? [next.deleteEditFor] : []),
        ]
        // The shared draft keeps what each commit replaced so an earlier revision can
        // be rebuilt for Publish. Read before any write in this transaction.
        const touched = [
          ...new Set([...updates.map((edit) => edit.plateId), ...deletes]),
        ]
        const previousEdits =
          draft && touched.length && next.history !== false
            ? await transaction.getAll(
                ...touched.map((id) => batchRef.collection('edits').doc(id))
              )
            : []
        const previous = batch.data() as ReviewBatch
        const beforeEdits = new Map(
          previousEdits.map((snapshot) => [
            snapshot.id,
            snapshot.exists ? (snapshot.data() as ProposedEdit) : null,
          ])
        )
        const plateEditVersions = draft
          ? nextPlateEditVersions(
              previous,
              next.batch.revision,
              next.history === false ? [] : touched
            )
          : undefined
        if (draft)
          updates = updates.map((edit) => ({
            ...(next.history === false
              ? edit
              : recordEditAuthors(edit, beforeEdits.get(edit.plateId))),
            revision: next.batch.revision,
          }))
        const before = draft
          ? changeBefore(previous, next.batch, beforeEdits)
          : undefined
        const change =
          next.history === false
            ? null
            : draftChange(
                previous,
                next.batch,
                updates,
                deletes,
                next.by,
                before
              )
        if (change)
          transaction.set(
            batchRef
              .collection('draftChanges')
              .doc(String(next.batch.revision)),
            change
          )
        transaction.set(batchRef, {
          ...next.batch,
          ...(plateEditVersions && { plateEditVersions }),
          ...(batch.get('publishAbandonment')
            ? { publishAbandonment: batch.get('publishAbandonment') }
            : {}),
          ...(batch.get('approvalRun')
            ? { approvalRun: batch.get('approvalRun') }
            : {}),
          ...(batch.get('publishRequestedAt') &&
          ['approved', 'published'].includes(next.batch.state)
            ? {
                publishRequestedAt: batch.get('publishRequestedAt'),
                ...(batch.get('publishRequestedBy')
                  ? { publishRequestedBy: batch.get('publishRequestedBy') }
                  : {}),
              }
            : {}),
          env,
        })
        transaction.set(signal(batchId), { revision: next.batch.revision })
        if (next.deleteEditFor !== undefined) {
          transaction.delete(
            batchRef.collection('edits').doc(next.deleteEditFor)
          )
        }
        for (const id of next.deleteEditsFor ?? [])
          transaction.delete(batchRef.collection('edits').doc(id))
        for (const edit of updates) {
          transaction.set(batchRef.collection('edits').doc(edit.plateId), edit)
        }
        if (before) {
          touchStates?.([
            ...(change?.states ?? touched.map((id) => id.split('.')[0])),
            ...Object.keys(before.stateOrders),
            ...Object.keys(before.baselineOrders),
            ...(next.publishedStates ?? []),
          ])
        }
        return 'ok'
      }
      return scopedTransaction
        ? run(scopedTransaction, scopedTouchStates)
        : transact(run)
    },
  }
}
