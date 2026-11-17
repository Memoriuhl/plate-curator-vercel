import { Timestamp, type Firestore } from '@google-cloud/firestore'
import type { LiveAccessDeps } from './access'

export function firestoreLiveAccessWriter(db: Firestore): LiveAccessDeps['write'] {
  return async (uid, envKey, expiresAt) => {
    await db.doc(`curatorLiveAccess/${uid}`).set({ envs: { [envKey]: Timestamp.fromDate(expiresAt) } }, { merge: true })
  }
}
