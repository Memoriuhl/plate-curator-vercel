import type { Firestore } from '@google-cloud/firestore'
import type { BatchSignalsBackfillStore } from './backfill-signals'
import { liveEnvKey, signalPath } from './live-signal'

/** Adapt Firestore for the staging task that fills missing batch revision signals. */
export function firestoreBatchSignalsBackfillStore(db: Firestore): BatchSignalsBackfillStore {
  return {
    /** List batch IDs in the review environment selected for the backfill. */
    async listBatchIds(env) {
      return (await db.collection('reviewBatches').where('env', '==', env).select().get()).docs.map(doc => doc.id)
    },
    /**
     * Create the batch's current revision signal only when the document is still
     * missing.
     */
    async initializeMissing(batchId, env) {
      return db.runTransaction(async transaction => {
        const batch = await transaction.get(db.doc(`reviewBatches/${batchId}`))
        const signal = db.doc(signalPath(liveEnvKey(env), batchId))
        const existing = await transaction.get(signal)
        if (!batch.exists || batch.get('env') !== env || existing.exists) return false
        transaction.create(signal, { revision: batch.get('revision') })
        return true
      })
    },
  }
}
