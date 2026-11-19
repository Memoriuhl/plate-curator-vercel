import { randomUUID } from 'node:crypto'
import type { DocumentSnapshot, Firestore } from '@google-cloud/firestore'
import { countActivePipeline } from '../../publish/pipeline-gate'
import { sharedDraftId } from '../draft/draft-id'
import type { MigrationFence } from './migrate'

/** How long a migration holds its environment without confirming it is still running. */
export const migrationHoldMs = 10 * 60_000

/** The live catalog version on the pointer, or null when the pointer has none. */
function pointerVersion(pointer: DocumentSnapshot): number | null {
  const version = pointer.get('version')
  return typeof version === 'number' ? version : null
}

/**
 * Hold a review environment for the shared draft migration by taking the publish lock
 * with purpose `migration`, in the same transaction that checks nothing is publishing
 * and no pipeline work is queued or running there.
 *
 * The lock is what Publish and queue creation already read in their own transactions:
 * a Publish cannot claim it while it is live, and queue creation in this environment is
 * refused while it is held. The lock is one document for every environment because
 * they share the catalog pointer, so any live lease keeps the migration out. The hold
 * records the pointer version it saw; `confirm` refuses if the pointer has moved since,
 * so the fold is never written against a version it was not planned on. The fold's own
 * transaction checks the token, expiry and version again (`held`), so a hold lost
 * between `confirm` and that write cannot let a stale fold land. A run that
 * stops without releasing loses the hold after `migrationHoldMs`, and the next run
 * finishes the fold.
 */
export function firestoreMigrationFence(
  db: Firestore,
  env: string,
  now: () => number = Date.now
): MigrationFence {
  const lockRef = db.doc('locks/publish')
  const pointerRef = db.doc('config/catalog')
  const token = randomUUID()
  let version: number | null = null
  const expiresAt = () => new Date(now() + migrationHoldMs).toISOString()
  const live = (lock: DocumentSnapshot) =>
    lock.exists && Date.parse(lock.get('expiresAt')) > now()
  return {
    acquire: () =>
      db.runTransaction(async (tx) => {
        const [lock, pointer] = await tx.getAll(lockRef, pointerRef)
        if (live(lock))
          return lock.get('purpose') === 'migration' && lock.get('env') === env
            ? 'migration_running'
            : 'publish_locked'
        if ((await countActivePipeline(db, tx, env, true)) > 0)
          return 'pipeline_busy'
        version = pointerVersion(pointer)
        tx.set(lockRef, {
          token,
          env,
          purpose: 'migration',
          batchId: sharedDraftId(env),
          revision: 0,
          catalogVersion: version,
          expiresAt: expiresAt(),
        })
        return null
      }),
    confirm: () =>
      db.runTransaction(async (tx) => {
        const [lock, pointer] = await tx.getAll(lockRef, pointerRef)
        if (lock.get('token') !== token || !live(lock))
          return 'reservation_lost'
        if (pointerVersion(pointer) !== version) return 'catalog_moved'
        tx.update(lockRef, { expiresAt: expiresAt() })
        return null
      }),
    held: () => ({ token, catalogVersion: version }),
    release: () =>
      db.runTransaction(async (tx) => {
        const lock = await tx.get(lockRef)
        if (lock.get('token') === token) tx.delete(lockRef)
      }),
  }
}
