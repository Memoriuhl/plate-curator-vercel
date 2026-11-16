'use client'

import Link, { useLinkStatus } from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { IoReloadOutline } from 'react-icons/io5'
import type { JurisdictionSummary } from '@/lib/catalog/dashboard-types'
import { cn } from '@/components/utils'

function PendingIndicator() {
  const { pending } = useLinkStatus()
  return (
    <span
      role="status"
      data-navigation-pending={pending || undefined}
      className={cn('absolute right-2 top-2 size-3 transition-opacity', pending ? 'opacity-100' : 'opacity-0')}
    >
      {pending ? (
        <>
          <IoReloadOutline className="size-3 motion-safe:animate-spin" aria-hidden="true" />
          <span className="sr-only">Loading jurisdiction…</span>
        </>
      ) : null}
    </span>
  )
}

export function JurisdictionCard({ jurisdiction }: { jurisdiction: JurisdictionSummary }) {
  const params = useParams<{ code: string }>()
  const selected = params.code === jurisdiction.code
  const [prefetch, setPrefetch] = useState<false | null>(false)
  const ref = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    const card = ref.current
    const strip = card?.closest('.jurisdiction-strip')
    if (!selected || !card || !strip) return
    const bounds = card.getBoundingClientRect()
    const viewport = strip.getBoundingClientRect()
    if (bounds.left < viewport.left || bounds.right > viewport.right)
      card.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selected])
  const percent = jurisdiction.plateCount
    ? (jurisdiction.completeCount / jurisdiction.plateCount) * 100
    : 0
  return (
    <Link
      ref={ref}
      href={`/states/${jurisdiction.code}`}
      prefetch={prefetch}
      onMouseEnter={() => setPrefetch(null)}
      onFocus={() => setPrefetch(null)}
      scroll={false}
      aria-current={selected ? 'page' : undefined}
      className={cn('jurisdiction-card relative', selected && 'jurisdiction-selected')}
    >
      <strong>{jurisdiction.code}</strong>
      <PendingIndicator />
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
