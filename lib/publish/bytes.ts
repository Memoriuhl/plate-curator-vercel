import { createHash } from 'node:crypto'
import type { Snapshot } from '../catalog/types'

/**
 * Serialize a snapshot with stable object key order so retries produce the same bytes
 * and checksum.
 */
export function snapshotBytes(snapshot: Snapshot): Uint8Array {
  return Buffer.from(
    JSON.stringify(snapshot, (_key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]])
        )
      }
      return value
    })
  )
}

/** Compute the SHA-256 checksum used to identify and verify persisted snapshot bytes. */
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
