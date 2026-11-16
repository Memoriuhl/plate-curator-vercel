import 'server-only'
import { cache } from 'react'
import { catalog } from '../server/context'
import { cachedDashboard, cachedJurisdiction } from '../server/snapshot-cache'
import { buildJurisdiction, buildPlate } from './dashboard-build'
import { catalogSourceKind } from './source-kind'

const loadInputs = cache(async () => {
  const source = catalog()
  const [version, curator] = await Promise.all([source.readVersion(), source.readCuratorState()])
  return {
    version, curator, imageUrl: source.imageUrl,
    kind: catalogSourceKind({ CATALOG_SOURCE: process.env.CATALOG_SOURCE, VERCEL_ENV: process.env.VERCEL_ENV }),
    imageBase: process.env.PLATE_IMAGE_BASE || null,
  }
})

export const loadDashboard = cache(async () => {
  const { version, curator, kind, imageBase } = await loadInputs()
  const summary = await cachedDashboard(version, kind, imageBase)
  return {
    ...summary,
    jurisdictions: summary.jurisdictions.map(jurisdiction => ({
      ...jurisdiction, progress: curator.stateProgress[jurisdiction.code] ?? null,
    })),
  }
})

export const loadJurisdiction = cache(async (code: string) => {
  const { version, curator, imageUrl, kind } = await loadInputs()
  const snapshot = await cachedJurisdiction(version, code, kind)
  return buildJurisdiction(snapshot, curator, imageUrl, code)
})

export const loadPlate = cache(async (id: string) => {
  const { version, curator, imageUrl, kind } = await loadInputs()
  const snapshot = await cachedJurisdiction(version, id.split('.')[0], kind)
  return buildPlate(snapshot, curator, imageUrl, id)
})
