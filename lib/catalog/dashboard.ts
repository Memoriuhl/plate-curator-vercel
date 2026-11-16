import 'server-only'
import { cache } from 'react'
import { catalog } from '../server/context'
import { cachedSnapshot } from '../server/snapshot-cache'
import { buildDashboard, buildJurisdiction, buildPlate } from './dashboard-build'

const loadInputs = cache(async () => {
  const source = catalog(cachedSnapshot)
  const [snapshot, curator] = await Promise.all([source.readSnapshot(), source.readCuratorState()])
  return { snapshot, curator, imageUrl: source.imageUrl }
})

export const loadDashboard = cache(async () => {
  const { snapshot, curator, imageUrl } = await loadInputs()
  return buildDashboard(snapshot, curator, imageUrl)
})

export const loadJurisdiction = cache(async (code: string) => {
  const { snapshot, curator, imageUrl } = await loadInputs()
  return buildJurisdiction(snapshot, curator, imageUrl, code)
})

export const loadPlate = cache(async (id: string) => {
  const { snapshot, curator, imageUrl } = await loadInputs()
  return buildPlate(snapshot, curator, imageUrl, id)
})
