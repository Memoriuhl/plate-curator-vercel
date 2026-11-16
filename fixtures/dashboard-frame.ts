import catalog from './catalog-demo.json'
import curator from './curator-state-demo.json'
import {
  buildDashboard,
  buildJurisdiction,
} from '../lib/catalog/dashboard-build'
import type { Snapshot } from '../lib/catalog/types'
import type {
  DashboardData,
  JurisdictionData,
} from '../lib/catalog/dashboard-types'

const snapshot = catalog as Snapshot
const imageUrl = () => null
export const dashboardFixture: DashboardData = buildDashboard(
  snapshot,
  curator,
  imageUrl,
)
export const alaskaFixture: JurisdictionData = buildJurisdiction(
  snapshot,
  curator,
  imageUrl,
  'AK',
)!
