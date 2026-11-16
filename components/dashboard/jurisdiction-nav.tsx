'use client'

import type { ReactNode } from 'react'
import { useParams, usePathname } from 'next/navigation'
import type { JurisdictionSummary } from '@/lib/catalog/dashboard-types'
import { routeRegion } from '@/components/app/regions'
import { JurisdictionCard } from './jurisdiction-card'

export function JurisdictionNav({ jurisdictions, children }: { jurisdictions: JurisdictionSummary[]; children?: ReactNode }) {
  const params = useParams()
  const pathname = usePathname()
  const region = routeRegion(params, pathname, jurisdictions)
  const visible = jurisdictions.filter((jurisdiction) => jurisdiction.region === region)
  return (
    <nav className="jurisdiction-strip" aria-label="Jurisdictions">
      <div className="jurisdiction-region">{children}</div>
      {visible.length ? visible.map((jurisdiction) => (
        <JurisdictionCard key={jurisdiction.code} jurisdiction={jurisdiction} />
      )) : <p>No jurisdictions available.</p>}
    </nav>
  )
}
