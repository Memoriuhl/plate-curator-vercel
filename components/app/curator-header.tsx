import { Suspense } from 'react'
import { connection } from 'next/server'
import { loadDashboard } from '@/lib/catalog/dashboard'
import { Brand } from './brand'
import { RegionPill, StaticRegionPill } from './region-pill'
import { summarizeRegions } from './regions'
import { WorkspaceTabs } from './workspace-tabs'
import { HeaderActions } from './header-actions'

async function RegionLoader() {
  await connection()
  const { jurisdictions } = await loadDashboard()
  return <RegionPill
    regions={summarizeRegions(jurisdictions)}
    jurisdictions={jurisdictions.map(({ code, region }) => ({ code, region }))}
  />
}

export function CuratorHeader() {
  return (
    <header className="app-header">
      <div className="brand-region">
        <Brand />
        <Suspense fallback={<StaticRegionPill />}>
          <RegionLoader />
        </Suspense>
      </div>
      <WorkspaceTabs />
      <HeaderActions />
    </header>
  )
}
