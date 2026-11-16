import type { Firestore } from '@google-cloud/firestore'
import type { ProposedEdit, ReviewBatch, ReviewStore } from './types'

export function firestoreReviewStore(db: Firestore, env: string): ReviewStore {
  const batches = db.collection('reviewBatches')

  return {
    async getBatch(id) {
      const snapshot = await batches.doc(id).get()
      const { env: storedEnv, ...batch } = snapshot.data() ?? {}
      return storedEnv === env ? batch as ReviewBatch : null
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
