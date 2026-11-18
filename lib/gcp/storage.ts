import 'server-only'
import type { Snapshot } from '../catalog/types'
import { requireEnv } from '../env'
import { gcpAuthClient } from './credentials'

const snapshots = new Map<number, Promise<Snapshot>>()

/**
 * Keep each immutable snapshot's promise in process memory so concurrent and later
 * reads share one download. Evict failures so the next read can retry.
 */
export function loadSnapshot(version: number): Promise<Snapshot> {
  let snapshot = snapshots.get(version)
  if (!snapshot) {
    snapshot = fetchSnapshot(version)
    snapshots.set(version, snapshot)
    snapshot.catch(() => snapshots.delete(version))
  }
  return snapshot
}

/**
 * Fetch and decode one catalog snapshot from the configured storage bucket with Google
 * credentials.
 */
async function fetchSnapshot(version: number): Promise<Snapshot> {
  const bucket = requireEnv('FIREBASE_STORAGE_BUCKET')
  const object = encodeURIComponent(`catalog/v${version}.json`)
  const { token } = await gcpAuthClient().getAccessToken()
  const response = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${object}?alt=media`,
    {
      headers: { Authorization: `Bearer ${token}` },
      // The version-keyed promise above controls reuse of these authenticated downloads.
      cache: 'no-store',
    }
  )
  if (!response.ok)
    throw new Error(`Snapshot v${version} unavailable: ${response.status}`)
  return (await response.json()) as Snapshot
}
