import type { Firestore } from '@google-cloud/firestore'
import { countActivePipeline } from '../publish/pipeline-gate'
import type { MigrationBlock } from './migrate'

/**
 * Report why the shared draft migration must wait: a publish holds the lock for this
 * review environment, or pipeline work is still queued or running against its Batches.
 * Folding Batches under either would race a Publish or a result write.
 */
export async function firestoreMigrationBlock(
  db: Firestore,
  env: string,
  now: () => number = Date.now
): Promise<MigrationBlock | null> {
  return db.runTransaction(
    async (tx) => {
      const lock = await tx.get(db.doc('locks/publish'))
      if (
        lock.exists &&
        lock.get('env') === env &&
        Date.parse(lock.get('expiresAt')) > now()
      )
        return 'publish_locked'
      if ((await countActivePipeline(db, tx, env, true)) > 0)
        return 'pipeline_busy'
      return null
    },
    { readOnly: true }
  )
}
