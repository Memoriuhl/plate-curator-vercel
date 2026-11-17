'use client'

import { useSelectedBatchId } from '@/lib/client/hooks'

import Link, { useLinkStatus } from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { IoReloadOutline } from 'react-icons/io5'
import type { JurisdictionSummary } from '@/lib/catalog/dashboard-types'
import { cn } from '@/components/utils'

function PendingIndicator() {
  const { pending } = useLinkStatus()
  if (!pending) return null
  return (
    <span
      role="status"
      data-navigation-pending
      className="absolute right-2 top-2 size-3"
    >
      <IoReloadOutline className="size-3 motion-safe:animate-spin" aria-hidden="true" />
      <span className="sr-only">Loading jurisdiction…</span>
    </span>
  )
}

export function JurisdictionCard({ jurisdiction, prefetchNearby = false }: { jurisdiction: JurisdictionSummary; prefetchNearby?: boolean }) {
  const batchId = useSelectedBatchId()
  const params = useParams<{ code: string }>()
  const selected = params.code === jurisdiction.code
  const [prefetch, setPrefetch] = useState<true | 'auto'>('auto')
  const ref = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    const card = ref.current
    const strip = card?.closest<HTMLElement>('.jurisdiction-strip')
    if (!selected || !card || !strip) return
    const reveal = () => {
      const bounds = card.getBoundingClientRect()
      const viewport = strip.getBoundingClientRect()
      const vertical = getComputedStyle(strip).flexDirection === 'column'
      const start = vertical ? bounds.top : bounds.left
      const end = vertical ? bounds.bottom : bounds.right
      const viewportStart = vertical ? viewport.top + strip.clientTop : viewport.left + strip.clientLeft
      const viewportEnd = viewportStart + (vertical ? strip.clientHeight : strip.clientWidth)
      const delta = start < viewportStart ? start - viewportStart : end > viewportEnd ? end - viewportEnd : 0
      if (delta) strip.scrollBy(vertical ? { top: delta } : { left: delta })
    }
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [selected])
  const percent = jurisdiction.plateCount
    ? (jurisdiction.completeCount / jurisdiction.plateCount) * 100
    : 0
  return (
    <Link
      ref={ref}
      href={`/states/${jurisdiction.code}${batchId !== null ? `?batch=${encodeURIComponent(batchId)}` : ''}`}
      prefetch={prefetchNearby || prefetch}
      onMouseEnter={() => setPrefetch(true)}
      onFocus={() => setPrefetch(true)}
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
