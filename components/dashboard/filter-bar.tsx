'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  IoBulbOutline,
  IoPricetagOutline,
  IoHappyOutline,
} from 'react-icons/io5'
import type { FilterCounts } from './family-data'
import { useWorkspaceBatch, useBatches } from '@/lib/client/hooks'
import { Toggle } from '@/components/ui/toggle'
import { StatusIcon } from '@/components/plate/status-icon'

export function FilterBar({
  counts,
  code,
}: {
  counts: FilterCounts
  code: string
}) {
  const workspace = useWorkspaceBatch()
  const batches = useBatches(['open'], { mine: true })
  const batch = workspace.mode === 'selected' ? workspace.detail?.batch : batches.data?.[0]
  const changedCount = new Set(
    batch?.plateIds.filter((id) => id.startsWith(code + '.')) ?? [],
  ).size
  return <FilterBarControls counts={counts} changedCount={changedCount} />
}

export function FilterBarControls({
  counts,
  changedCount,
}: {
  counts: FilterCounts
  changedCount: number
}) {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const filters = [
    { key: 'all', label: 'All plates', count: counts.all },
    { key: 'changed', label: 'Changed in a batch', count: changedCount },
    {
      key: 'nofunfacts',
      label: 'No fun facts',
      count: counts.nofunfacts,
      icon: IoBulbOutline,
    },
    {
      key: 'undertagged',
      label: 'Under-tagged',
      count: counts.undertagged,
      icon: IoPricetagOutline,
    },
    {
      key: 'generic',
      label: 'Generic description',
      count: counts.generic,
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
      <div
        className="status-legend"
        role="group"
        aria-label="Check status legend"
      >
        {(['good', 'weak', 'missing'] as const).map((status) => (
          <span key={status} className="inline-flex items-center">
            <StatusIcon
              checkKey="description"
              check={{ status, value: status }}
            />
            {status}
          </span>
        ))}
      </div>
    </div>
  )
}
