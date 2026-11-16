'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  IoBulbOutline,
  IoPricetagOutline,
  IoHappyOutline,
} from 'react-icons/io5'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import { useBatches } from '@/lib/client/hooks'
import { Toggle } from '@/components/ui/toggle'
import { StatusIcon } from '@/components/plate/status-icon'

export function FilterBar({ plates }: { plates: PlateCardData[] }) {
  const batches = useBatches(['open'], { mine: true })
  const changed = new Set(batches.data?.[0]?.plateIds ?? [])
  return (
    <FilterBarControls
      plates={plates}
      changedCount={plates.filter((plate) => changed.has(plate.id)).length}
    />
  )
}

export function FilterBarControls({
  plates,
  changedCount,
}: {
  plates: PlateCardData[]
  changedCount: number
}) {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const filters = [
    { key: 'all', label: 'All plates', count: plates.length },
    { key: 'changed', label: 'Changed in a batch', count: changedCount },
    {
      key: 'nofunfacts',
      label: 'No fun facts',
      count: plates.filter(
        (plate) => plate.checks.funFacts.status === 'missing',
      ).length,
      icon: IoBulbOutline,
    },
    {
      key: 'undertagged',
      label: 'Under-tagged',
      count: plates.filter((plate) => plate.checks.tags.status !== 'good')
        .length,
      icon: IoPricetagOutline,
    },
    {
      key: 'generic',
      label: 'Generic description',
      count: plates.filter(
        (plate) => plate.checks.description.status !== 'good',
      ).length,
      icon: IoHappyOutline,
    },
  ]
  const selected = filters.some((filter) => filter.key === params.get('show'))
    ? params.get('show')
    : 'all'
  return (
    <div className="filter-bar">
      <div className="filter-chips" role="group" aria-label="Filter plates">
        {filters.map((filter, index) => (
          <span className="filter-item" key={filter.key}>
            {index === 2 ? (
              <span className="needs-work">Needs work</span>
            ) : null}
            <Toggle
              count={filter.count}
              pressed={selected === filter.key}
              onPressedChange={() => {
                const next = new URLSearchParams(params)
                next.set('show', filter.key)
                router.replace(`${pathname}?${next}`, { scroll: false })
              }}
            >
              {filter.icon ? <filter.icon aria-hidden="true" /> : null}
              {filter.label}
            </Toggle>
          </span>
        ))}
      </div>
      <div className="status-legend" role="group" aria-label="Check status legend">
        {(['good', 'weak', 'missing'] as const).map((status) => (
          <span key={status} className="inline-flex items-center">
            <StatusIcon checkKey="description" check={{ status, value: status }} />
            {status}
          </span>
        ))}
      </div>
    </div>
  )
}
