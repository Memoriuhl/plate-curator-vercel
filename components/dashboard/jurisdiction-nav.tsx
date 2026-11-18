'use client'

import { useEffect, type ReactNode } from 'react'
import { useParams, usePathname, useRouter } from 'next/navigation'
import type { JurisdictionSummary } from '@/lib/catalog/dashboard-types'
import { routeRegion } from '@/components/app/regions'
import { JurisdictionCard } from './jurisdiction-card'

/**
 * Render jurisdiction navigation with region selection and the active state kept in
 * view.
 */
export function JurisdictionNav({ jurisdictions, children }: { jurisdictions: JurisdictionSummary[]; children?: ReactNode }) {
  const params = useParams()
  const pathname = usePathname()
  const router = useRouter()
  const region = routeRegion(params, pathname, jurisdictions)
  const visible = jurisdictions.filter((jurisdiction) => jurisdiction.region === region)
  const selected = visible.findIndex(jurisdiction => jurisdiction.code === params.code)
  const nearby = visible.filter((_, index) => selected >= 0 && index !== selected && Math.abs(index - selected) <= 2).map(jurisdiction => jurisdiction.code).join(',')
  useEffect(() => {
    for (const code of nearby.split(',').filter(Boolean)) router.prefetch(`/states/${code}`)
  }, [nearby, router])
  return (
    <nav className="jurisdiction-strip" aria-label="Jurisdictions">
      <div className="jurisdiction-region">{children}</div>
      {visible.length ? visible.map((jurisdiction, index) => (
        <JurisdictionCard key={jurisdiction.code} jurisdiction={jurisdiction} prefetchNearby={selected >= 0 && index !== selected && Math.abs(index - selected) <= 2} />
      )) : <p>No jurisdictions available.</p>}
    </nav>
  )
}
