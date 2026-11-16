'use client'

import { useParams, usePathname, useRouter } from 'next/navigation'
import { REGIONS, routeRegion, type JurisdictionRegion, type RegionSummary } from './regions'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'

export function StaticRegionPill() {
  return (
    <Select value="US" disabled>
      <SelectTrigger aria-label="Region">
        <SelectValue><span aria-hidden="true">🇺🇸</span> US</SelectValue>
      </SelectTrigger>
    </Select>
  )
}

export function RegionPill({ regions, jurisdictions }: {
  regions: RegionSummary[]
  jurisdictions: JurisdictionRegion[]
}) {
  const params = useParams()
  const pathname = usePathname()
  const router = useRouter()
  const region = routeRegion(params, pathname, jurisdictions)
  const current = REGIONS.find((option) => option.region === region) ?? REGIONS[0]
  return (
    <Select value={current.region} onValueChange={(value) => {
      const destination = regions.find((summary) => summary.region === value && summary.count > 0)
      if (destination) router.push(`/states/${destination.firstCode}`)
    }}>
      <SelectTrigger aria-label="Region">
        <SelectValue>
          <span aria-hidden="true">{current.flag}</span> {current.region}
        </SelectValue>
      </SelectTrigger>
      <SelectContent position="popper">
        {REGIONS.map((option) => {
          const enabled = regions.some((summary) => summary.region === option.region && summary.count > 0)
          return (
            <SelectItem key={option.region} value={option.region} disabled={!enabled}>
              <span aria-hidden="true">{option.flag}</span>
              {option.name}
              {!enabled ? <span className="text-xs text-muted-foreground">Coming soon</span> : null}
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}
