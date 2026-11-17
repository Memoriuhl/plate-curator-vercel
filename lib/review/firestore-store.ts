import type { Firestore } from '@google-cloud/firestore'
import { liveEnvKey, signalPath } from './live-signal'
import type { ProposedEdit, ReviewBatch, ReviewStore } from './types'

export function firestoreReviewStore(db: Firestore, env: string): ReviewStore {
  const batches = db.collection('reviewBatches')
  const signal = (batchId: string) => db.doc(signalPath(liveEnvKey(env), batchId))

  return {
    async create(batch) {
      try {
        await db.runTransaction(async transaction => {
          transaction.create(batches.doc(batch.id), { ...batch, env })
          transaction.set(signal(batch.id), { revision: batch.revision })
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
    async requestPublish(batchId, revision, at) {
      return db.runTransaction(async transaction => {
        const ref = batches.doc(batchId)
        const batch = await transaction.get(ref)
        if (batch.get('env') !== env || batch.get('state') !== 'approved' || batch.get('revision') !== revision) return false
        transaction.update(ref, { publishRequestedAt: at })
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
          ...(batch.get('approvalRun') ? { approvalRun: batch.get('approvalRun') } : {}),
          ...(batch.get('publishRequestedAt') && ['approved', 'published'].includes(next.batch.state) ? { publishRequestedAt: batch.get('publishRequestedAt') } : {}),
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
