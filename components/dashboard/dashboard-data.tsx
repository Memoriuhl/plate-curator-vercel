import { Suspense } from 'react'
import { connection } from 'next/server'
import { notFound } from 'next/navigation'
import { loadDashboard, loadJurisdiction } from '@/lib/catalog/dashboard'
import { JurisdictionCard } from './jurisdiction-card'
import { StateHeader } from './state-header'
import { FilterBar } from './filter-bar'
import { FamilyGrid } from './family-grid'

export async function JurisdictionStrip({ code }: { code: string }) {
  await connection()
  const { jurisdictions } = await loadDashboard()
  return (
    <nav className="jurisdiction-strip" aria-label="Jurisdictions">
      {jurisdictions.length ? (
        jurisdictions.map((jurisdiction) => (
          <JurisdictionCard
            key={jurisdiction.code}
            jurisdiction={jurisdiction}
            selected={code === jurisdiction.code}
          />
        ))
      ) : (
        <p>No jurisdictions available.</p>
      )}
    </nav>
  )
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
        <FilterBar plates={jurisdiction.plates} />
      </Suspense>
      <Suspense fallback={<p>Loading families...</p>}>
        <FamilyGrid plates={jurisdiction.plates} />
      </Suspense>
      {jurisdiction.plates.length === 0 ? (
        <p>No plates in this jurisdiction yet.</p>
      ) : null}
    </>
  )
}
