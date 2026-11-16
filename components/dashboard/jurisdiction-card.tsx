'use client'

import Link from 'next/link'
import { useEffect, useRef } from 'react'
import type { JurisdictionSummary } from '@/lib/catalog/dashboard-types'
import { cn } from '@/components/utils'

export function JurisdictionCard({
  jurisdiction,
  selected,
}: {
  jurisdiction: JurisdictionSummary
  selected: boolean
}) {
  const ref = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    if (selected)
      ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selected])
  const percent = jurisdiction.plateCount
    ? (jurisdiction.completeCount / jurisdiction.plateCount) * 100
    : 0
  return (
    <Link
      ref={ref}
      href={`/states/${jurisdiction.code}`}
      aria-current={selected ? 'page' : undefined}
      className={cn('jurisdiction-card', selected && 'jurisdiction-selected')}
    >
      <strong>{jurisdiction.code}</strong>
      <span className="caption">{jurisdiction.name}</span>
      <span
        className="jurisdiction-progress"
        role="progressbar"
        aria-label={`${jurisdiction.name} complete`}
        aria-valuemin={0}
        aria-valuemax={jurisdiction.plateCount || 1}
        aria-valuenow={jurisdiction.completeCount}
      >
        <span style={{ width: `${percent}%` }} />
      </span>
      <span className="id">
        {jurisdiction.completeCount}/{jurisdiction.plateCount} complete
      </span>
    </Link>
  )
}
