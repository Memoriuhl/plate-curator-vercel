import type { Firestore } from '@google-cloud/firestore'
import type { ProposedEdit, ReviewBatch, ReviewStore } from './types'

export function firestoreReviewStore(db: Firestore, env: string): ReviewStore {
  const batches = db.collection('reviewBatches')

  return {
    async create(batch) {
      try {
        await batches.doc(batch.id).create({ ...batch, env })
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
        transaction.set(batchRef, { ...next.batch, env })
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
