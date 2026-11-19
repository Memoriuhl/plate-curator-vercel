import 'server-only'
import { cache } from 'react'
import { cacheLife } from 'next/cache'
import { buildDashboard } from '../catalog/dashboard-build'
import { fixtureSource } from '../catalog/fixture-source'
import { plateImageUrl } from '../catalog/image-url'
import type { CatalogSourceKind } from '../catalog/source-kind'
import type { Snapshot } from '../catalog/types'
import { loadSnapshot } from '../gcp/storage'

/** Memoize the versioned source snapshot per server render so projections share the same load. */
export const snapshotForVersion = cache(
  async (version: number, kind: CatalogSourceKind): Promise<Snapshot> => {
    if (kind === 'fixture') {
      const snapshot = await fixtureSource().readSnapshot()
      if (snapshot.version !== version)
        throw new Error(`Fixture catalog v${version} unavailable`)
      return snapshot
    }
    return loadSnapshot(version)
  }
)

/** Read only the fields needed to reserve family labels across the catalog. */
export async function cachedCatalogFamilies(
  version: number,
  kind: CatalogSourceKind
) {
  'use cache: remote'
  cacheLife('max')
  const { plates } = await snapshotForVersion(version, kind)
  return plates.map(({ id, state, templateFamily, deleted }) => ({
    id,
    state,
    templateFamily,
    deleted,
  }))
}

/**
 * Cache one immutable state slice per version remotely. This keeps entries small
 * and skips a full catalog scan on repeat reads.
 */
export async function cachedJurisdiction(
  version: number,
  code: string,
  kind: CatalogSourceKind
): Promise<Snapshot> {
  'use cache: remote'
  cacheLife('max')
  const snapshot = await snapshotForVersion(version, kind)
  return {
    version,
    plates: snapshot.plates.filter((plate) => plate.state === code),
  }
}

/**
 * Cache the compact dashboard summaries by version, source and image base so
 * navigation can reuse the projection.
 */
export async function cachedDashboard(
  version: number,
  kind: CatalogSourceKind,
  imageBase: string | null
) {
  'use cache: remote'
  cacheLife('max')
  const snapshot = await snapshotForVersion(version, kind)
  return buildDashboard(
    snapshot,
    { stateOrder: {}, stateProgress: {} },
    (plate) => plateImageUrl(plate, imageBase)
  )
}
