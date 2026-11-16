import { Suspense } from 'react'
import { connection } from 'next/server'
import { notFound } from 'next/navigation'
import { loadDashboard, loadJurisdiction } from '@/lib/catalog/dashboard'
import { JurisdictionNav } from './jurisdiction-nav'
import { StateHeader } from './state-header'
import { FilterBar } from './filter-bar'
import { FamilyGrid } from './family-grid'
import { filterCounts, projectFamilyPlate } from './family-data'

export async function JurisdictionStrip() {
  await connection()
  const { jurisdictions } = await loadDashboard()
  return <JurisdictionNav jurisdictions={jurisdictions} />
}

export async function StateContent({ code }: { code: string }) {
  await connection()
  const jurisdiction = await loadJurisdiction(code)
  if (!jurisdiction) notFound()
  return (
    <>
      <StateHeader jurisdiction={jurisdiction} />
      <Suspense
        fallback={
          <div className="filter-loading" role="status">
            Loading filters…
          </div>
        }
      >
        <FilterBar
          counts={filterCounts(jurisdiction.plates)}
          code={jurisdiction.code}
        />
      </Suspense>
      <Suspense fallback={<p>Loading families...</p>}>
        <FamilyGrid plates={jurisdiction.plates.map(projectFamilyPlate)} />
      </Suspense>
      {jurisdiction.plates.length === 0 ? (
        <p>No plates in this jurisdiction yet.</p>
      ) : null}
    </>
  )
}
