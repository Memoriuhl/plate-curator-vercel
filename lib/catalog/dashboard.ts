import 'server-only'
import { cache } from 'react'
import { catalog } from '../server/context'
import { cachedCatalogHead } from '../server/catalog-head'
import { cachedDashboard, cachedJurisdiction } from '../server/snapshot-cache'
import { buildJurisdiction, buildPlate } from './dashboard-build'
import { catalogSourceKind } from './source-kind'

/** Memoize the catalog head and source settings so loaders in one server render share them. */
const loadInputs = cache(async () => {
  const { version, curator } = await cachedCatalogHead()
  return {
    version,
    curator,
    imageUrl: catalog().imageUrl,
    kind: catalogSourceKind({
      CATALOG_SOURCE: process.env.CATALOG_SOURCE,
      VERCEL_ENV: process.env.VERCEL_ENV,
    }),
    imageBase: process.env.PLATE_IMAGE_BASE || null,
  }
})

/** Memoize the dashboard projection per server render so page and navigation can reuse it. */
export const loadDashboard = cache(async () => {
  const { version, curator, kind, imageBase } = await loadInputs()
  const summary = await cachedDashboard(version, kind, imageBase)
  return {
    ...summary,
    jurisdictions: summary.jurisdictions.map((jurisdiction) => ({
      ...jurisdiction,
      progress: curator.stateProgress[jurisdiction.code] ?? null,
    })),
  }
})

/** Memoize each jurisdiction's ordered projection so callers in one render build it once. */
export const loadJurisdiction = cache(async (code: string) => {
  const { version, curator, imageUrl, kind } = await loadInputs()
  const snapshot = await cachedJurisdiction(version, code, kind)
  return buildJurisdiction(snapshot, curator, imageUrl, code)
})

/** Memoize each plate's detail per server render so duplicate lookups reuse the projection. */
export const loadPlate = cache(async (id: string) => {
  const { version, curator, imageUrl, kind } = await loadInputs()
  const snapshot = await cachedJurisdiction(version, id.split('.')[0], kind)
  return buildPlate(snapshot, curator, imageUrl, id)
})
