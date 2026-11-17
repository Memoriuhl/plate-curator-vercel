import type { DocumentSnapshot, Firestore, Transaction } from '@google-cloud/firestore'
import { liveEnvKey, signalPath } from './live-signal'
import type { ProposedEdit, PublishMetadata, ReviewBatch, ReviewStore } from './types'
import { receiptId } from '../publish/command'

export function writePublishMetadata(transaction: Transaction, batch: DocumentSnapshot, fields: PublishMetadata) {
  transaction.update(batch.ref, fields)
}

export function firestoreReviewStore(db: Firestore, env: string, scopedTransaction?: Transaction): ReviewStore {
  const batches = db.collection('reviewBatches')
  const signal = (batchId: string) => db.doc(signalPath(liveEnvKey(env), batchId))
  const create = (transaction: Transaction, batch: ReviewBatch) => {
    transaction.create(batches.doc(batch.id), { ...batch, env })
    transaction.set(signal(batch.id), { revision: batch.revision })
  }

  return {
    async updatePublishMetadata(batchId, revision, fields) {
      const write = async (transaction: Transaction) => {
        const batch = await transaction.get(batches.doc(batchId))
        if (batch.get('env') !== env || batch.get('revision') !== revision) return false
        writePublishMetadata(transaction, batch, fields)
        return true
      }
      return scopedTransaction ? write(scopedTransaction) : db.runTransaction(write)
    },
    async copy(input) {
      return db.runTransaction(async transaction => {
        const sourceRef = batches.doc(input.sourceId)
        const targetRef = batches.doc(input.batch.id)
        const [source, target, head, receipt] = await transaction.getAll(sourceRef, targetRef, db.doc('config/catalog'), db.doc(`publishRecords/${receiptId(input.sourceId, input.sourceRevision)}`))
        if (target.exists) {
          if (target.get('env') !== env) return { ok: false, error: 'not_found' }
          const value = target.data()!
          delete value.env
          delete value.publishReservation
          return { ok: true, value: value as ReviewBatch }
        }
        if (!source.exists || source.get('env') !== env) return { ok: false, error: 'not_found' }
        if (source.get('revision') !== input.sourceRevision) return { ok: false, error: 'superseded_revision' }
        if (source.get('state') !== 'approved') return { ok: false, error: 'invalid_state' }
        if (source.get('publishReservation') || receipt.get('committedAt')) return { ok: false, error: 'invalid_state' }
        const liveVersion = head.get('version')
        if (typeof liveVersion !== 'number') throw new Error('Catalog head unavailable')
        if (liveVersion !== input.targetVersion) return { ok: false, error: 'head_moved', liveVersion }
        create(transaction, input.batch)
        for (const edit of input.edits) transaction.create(targetRef.collection('edits').doc(edit.plateId), edit)
        return { ok: true, value: input.batch }
      })
    },
    async create(batch) {
      try {
        await db.runTransaction(async transaction => {
          create(transaction, batch)
        })
        return 'ok'
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 6) return 'exists'
        throw error
      }
    },
    async list(filter) {
      if (filter.states?.length === 0) return []
      let query = batches.where('env', '==', env)
      if (filter.states !== undefined) query = query.where('state', 'in', [...new Set(filter.states)])
      const snapshot = await query.get()
      return snapshot.docs.map(doc => {
        const batch = doc.data()
        delete batch.env
        delete batch.publishReservation
        return { ...batch, createdByName: batch.createdByName ?? null, stateOrders: batch.stateOrders ?? {} } as ReviewBatch
      }).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    },
    async listEdits(batchId) {
      return db.runTransaction(async transaction => {
        const batchRef = batches.doc(batchId)
        const batch = await transaction.get(batchRef)
        if (!batch.exists || batch.get('env') !== env) return []
        const edits = await transaction.get(batchRef.collection('edits'))
        return edits.docs.map(doc => doc.data() as ProposedEdit)
      }, { readOnly: true })
    },
    async readBatch(batchId) {
      return db.runTransaction(async transaction => {
        const ref = batches.doc(batchId)
        const snapshot = await transaction.get(ref)
        if (!snapshot.exists || snapshot.get('env') !== env) return null
        const edits = await transaction.get(ref.collection('edits'))
        const batch = snapshot.data()!
        delete batch.env
        delete batch.publishReservation
        return {
          batch: { ...batch, createdByName: batch.createdByName ?? null, stateOrders: batch.stateOrders ?? {} } as ReviewBatch,
          edits: edits.docs.map(doc => doc.data() as ProposedEdit),
        }
      }, { readOnly: true })
    },
    async getBatch(id) {
      const snapshot = await batches.doc(id).get()
      const { env: storedEnv, ...batch } = snapshot.data() ?? {}
      delete batch.publishReservation
      return storedEnv === env ? { ...batch, createdByName: batch.createdByName ?? null, stateOrders: batch.stateOrders ?? {} } as ReviewBatch : null
    },
    async getEdit(batchId, plateId) {
      return db.runTransaction(async transaction => {
        const batchRef = batches.doc(batchId)
        const batch = await transaction.get(batchRef)
        if (!batch.exists || batch.get('env') !== env) return null
        const edit = await transaction.get(batchRef.collection('edits').doc(plateId))
        return edit.exists ? edit.data() as ProposedEdit : null
      }, { readOnly: true })
    },
    async recordRun(batchId, revision, runId) {
      return db.runTransaction(async transaction => {
        const ref = batches.doc(batchId)
        const batch = await transaction.get(ref)
        if (batch.get('env') !== env || !(batch.get('state') === 'submitted' && batch.get('revision') === revision || batch.get('state') === 'approved' && batch.get('approval')?.revision === revision)) return false
        transaction.update(ref, { approvalRun: { runId, revision } })
        return true
      })
    },
    async requestPublish(batchId, revision, at, requestedBy) {
      return db.runTransaction(async transaction => {
        const ref = batches.doc(batchId)
        const batch = await transaction.get(ref)
        if (batch.get('env') !== env || batch.get('state') !== 'approved' || batch.get('revision') !== revision) return false
        transaction.update(ref, { publishRequestedAt: at, ...(requestedBy ? { publishRequestedBy: requestedBy } : {}) })
        return true
      })
    },
    async commit(batchId, expectedRevision, next) {
      return db.runTransaction(async transaction => {
        const batchRef = batches.doc(batchId)
        const batch = await transaction.get(batchRef)
        if (!batch.exists || batch.get('env') !== env || batch.get('revision') !== expectedRevision) {
          return 'revision_mismatch'
        }
        const reservation = batch.get('publishReservation')
        if (reservation) {
          if (next.publishToken !== reservation.token || next.batch.state !== 'published' || next.batch.revision !== expectedRevision + 1) return 'revision_mismatch'
          const record = await transaction.get(db.doc(`publishRecords/${reservation.recordId}`))
          if (!record.get('committedAt') || record.get('state') !== 'done' || record.get('env') !== env || record.get('revision') !== expectedRevision || record.get('batchId') !== batchId) return 'revision_mismatch'
        } else if (next.publishToken !== undefined) return 'revision_mismatch'
        transaction.set(batchRef, {
          ...next.batch,
          ...(batch.get('publishAbandonment') ? { publishAbandonment: batch.get('publishAbandonment') } : {}),
          ...(batch.get('approvalRun') ? { approvalRun: batch.get('approvalRun') } : {}),
          ...(batch.get('publishRequestedAt') && ['approved', 'published'].includes(next.batch.state) ? { publishRequestedAt: batch.get('publishRequestedAt'), ...(batch.get('publishRequestedBy') ? { publishRequestedBy: batch.get('publishRequestedBy') } : {}) } : {}),
          env,
        })
        transaction.set(signal(batchId), { revision: next.batch.revision })
        if (next.deleteEditFor !== undefined) {
          transaction.delete(batchRef.collection('edits').doc(next.deleteEditFor))
        }
        if (next.edit) {
          transaction.set(batchRef.collection('edits').doc(next.edit.plateId), next.edit)
        }
        return 'ok'
      })
    },
  }
}
