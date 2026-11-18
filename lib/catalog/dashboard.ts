import 'server-only'
import { cache } from 'react'
import { catalog } from '../server/context'
import { cachedCatalogHead } from '../server/catalog-head'
import { cachedDashboard, cachedJurisdiction } from '../server/snapshot-cache'
import { buildJurisdiction, buildPlate } from './dashboard-build'
import { catalogSourceKind } from './source-kind'

/** Share the catalog head and source settings across reads in one render. */
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

/** Load the dashboard summary and merge in the curator's saved state progress. */
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

/** Load a jurisdiction from the current catalog version and apply its saved state order. */
export const loadJurisdiction = cache(async (code: string) => {
  const { version, curator, imageUrl, kind } = await loadInputs()
  const snapshot = await cachedJurisdiction(version, code, kind)
  return buildJurisdiction(snapshot, curator, imageUrl, code)
})

/** Load plate detail from its jurisdiction so related plates share the same snapshot. */
export const loadPlate = cache(async (id: string) => {
  const { version, curator, imageUrl, kind } = await loadInputs()
  const snapshot = await cachedJurisdiction(version, id.split('.')[0], kind)
  return buildPlate(snapshot, curator, imageUrl, id)
})
