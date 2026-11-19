import type { PublishRecord, PublishSnapshots, SnapshotObject } from '../types'

/**
 * Compare the identity and verification metadata of two observations of a stored
 * snapshot.
 */
export function sameObject(
  a: SnapshotObject | null | undefined,
  b: SnapshotObject | null | undefined
): boolean {
  return (
    !!a &&
    !!b &&
    !!a.generation &&
    !!a.metageneration &&
    !!(a.md5Hash || a.crc32c) &&
    ['generation', 'metageneration', 'md5Hash', 'crc32c', 'url'].every(
      (key) => a[key as keyof SnapshotObject] === b[key as keyof SnapshotObject]
    )
  )
}

/**
 * Verify the prepared object's metadata and actual bytes against the receipt that
 * reserved it.
 */
export async function verifyPreparedObject(
  snapshots: PublishSnapshots,
  record: PublishRecord
): Promise<boolean> {
  const current = await snapshots.metadata(record.toVersion)
  if (record.url !== record.object?.url || !sameObject(record.object, current))
    return false
  if (
    (await snapshots.checksum(record.toVersion, current!.generation)) !==
    record.blobSha256
  )
    return false
  return sameObject(current, await snapshots.metadata(record.toVersion))
}
