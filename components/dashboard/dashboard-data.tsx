import { Suspense } from 'react'
import { connection } from 'next/server'
import { notFound } from 'next/navigation'
import { loadDashboard, loadJurisdiction } from '@/lib/catalog/dashboard'
import { RegionPill } from '@/components/app/region-pill'
import { summarizeRegions } from '@/components/app/regions'
import { JurisdictionNav } from './jurisdiction-nav'
import { StateHeader } from './state-header'
import { FamilyGrid } from './family-grid'
import { projectFamilyPlate } from './family-data'

/** Load and group jurisdiction summaries for the shared dashboard navigation. */
export async function JurisdictionStrip() {
  await connection()
  const { jurisdictions } = await loadDashboard()
  return (
    <JurisdictionNav jurisdictions={jurisdictions}>
      <RegionPill
        regions={summarizeRegions(jurisdictions)}
        jurisdictions={jurisdictions.map(({ code, region }) => ({
          code,
          region,
        }))}
      />
    </JurisdictionNav>
  )
}

/** Load the selected jurisdiction and render the plate grid or its empty state. */
export async function StateContent({ code }: { code: string }) {
  const jurisdiction = await loadJurisdiction(code)
  if (!jurisdiction) notFound()
  return (
    <>
      <StateHeader jurisdiction={jurisdiction} />
      <Suspense fallback={<p>Loading families...</p>}>
        <FamilyGrid
          catalogVersion={jurisdiction.catalogVersion}
          code={jurisdiction.code}
          plates={jurisdiction.plates.map(projectFamilyPlate)}
        />
      </Suspense>
      {jurisdiction.plates.length === 0 ? (
        <p>No plates in this jurisdiction yet.</p>
      ) : null}
    </>
  )
}
