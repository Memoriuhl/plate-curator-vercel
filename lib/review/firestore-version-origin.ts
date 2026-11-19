import type { Firestore } from '@google-cloud/firestore'
import type { PublishRecord } from '../publish/types'
import type { VersionOrigin } from './types'

/**
 * Read the publish receipt that moved the live catalog pointer to a version. The pointer
 * fence lets at most one receipt per target version commit, so the committed one is the
 * move. Receipts from every review environment count, because they share the pointer.
 */
export function firestoreVersionOrigin(
  db: Firestore
): (version: number) => Promise<VersionOrigin | null> {
  return async (version) => {
    const snapshot = await db
      .collection('publishRecords')
      .where('toVersion', '==', version)
      .get()
    const record = snapshot.docs
      .map((doc) => doc.data() as PublishRecord)
      .find(
        (candidate): candidate is PublishRecord & { committedAt: string } =>
          !!candidate.committedAt
      )
    return record ? versionOrigin(record) : null
  }
}

/** Map a committed receipt to the move it made. */
export function versionOrigin(
  record: PublishRecord & { committedAt: string }
): VersionOrigin {
  return {
    batchId: record.batchId,
    revision: record.revision,
    fromVersion: record.fromVersion,
    toVersion: record.toVersion,
    by: record.requestedBy?.uid ?? '',
    byName: record.requestedBy?.email ?? null,
    at: record.committedAt,
    // A committed receipt is 'uploaded' until the state-order projection lands.
    settled: record.state === 'done',
  }
}
