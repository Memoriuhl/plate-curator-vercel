import { Timestamp, type Firestore } from '@google-cloud/firestore'
import type { LiveAccessDeps } from './access'

/** Write a user's live access grant without replacing grants for other environments. */
export function firestoreLiveAccessWriter(
  db: Firestore
): LiveAccessDeps['write'] {
  return async (uid, envKey, expiresAt) => {
    await db
      .doc(`curatorLiveAccess/${uid}`)
      .set(
        { envs: { [envKey]: Timestamp.fromDate(expiresAt) } },
        { merge: true }
      )
  }
}
