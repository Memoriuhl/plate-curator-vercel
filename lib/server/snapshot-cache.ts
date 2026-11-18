import 'server-only'
import { cache } from 'react'
import { cacheLife } from 'next/cache'
import { buildDashboard } from '../catalog/dashboard-build'
import { fixtureSource } from '../catalog/fixture-source'
import { plateImageUrl } from '../catalog/image-url'
import type { CatalogSourceKind } from '../catalog/source-kind'
import type { Snapshot } from '../catalog/types'
import { loadSnapshot } from '../gcp/storage'

/** Resolve one immutable snapshot from the requested source and reuse it within a render. */
const snapshotForVersion = cache(async (version: number, kind: CatalogSourceKind): Promise<Snapshot> => {
  if (kind === 'fixture') {
    const snapshot = await fixtureSource().readSnapshot()
    if (snapshot.version !== version) throw new Error(`Fixture catalog v${version} unavailable`)
    return snapshot
  }
  return loadSnapshot(version)
})

/** Cache the plates for one jurisdiction by immutable snapshot version. */
export async function cachedJurisdiction(version: number, code: string, kind: CatalogSourceKind): Promise<Snapshot> {
  'use cache: remote'
  cacheLife('max')
  const snapshot = await snapshotForVersion(version, kind)
  return { version, plates: snapshot.plates.filter(plate => plate.state === code) }
}

/** Cache jurisdiction summaries from an immutable snapshot and the configured image base. */
export async function cachedDashboard(version: number, kind: CatalogSourceKind, imageBase: string | null) {
  'use cache: remote'
  cacheLife('max')
  const snapshot = await snapshotForVersion(version, kind)
  return buildDashboard(snapshot, { stateOrder: {}, stateProgress: {} }, plate => plateImageUrl(plate, imageBase))
}
