'use client'

import { useMemo } from 'react'
import { usePlateDetail, useDraftOverlay } from '@/lib/client/hooks'
import Image from 'next/image'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import { PLATE_CHECK_KEYS } from '@/lib/catalog/dashboard-types'
import { CHECK_META, StatusIcon } from '@/components/plate/status-icon'

type HoverCardProps = {
  plate: PlateCardData
  parent?: string
  left: number
  top: number
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

export default function PlateHoverCard(props: HoverCardProps) {
  const { data, error } = usePlateDetail(props.plate.id)
  const baselines = useMemo(() => (data ? [data.plate] : []), [data])
  const [overlaid] = useDraftOverlay(baselines)
  return (
    <PlateHoverContent
      {...props}
      plate={overlaid ?? props.plate}
      state={data ? undefined : error ? 'error' : 'loading'}
    />
  )
}

export function PlateHoverContent({
  plate,
  parent,
  left,
  top,
  onMouseEnter,
  onMouseLeave,
  state,
}: HoverCardProps & { state?: 'loading' | 'error' }) {
  return (
    <aside
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      role="tooltip"
      tabIndex={-1}
      aria-label={plate.displayName + ' preview'}
      className="fixed z-50 max-h-[calc(100dvh-16px)] w-[min(372px,calc(100vw-16px))] overflow-auto rounded-[var(--radius-lg)] bg-[var(--card)] p-4 text-[var(--ink)] shadow-xl"
      style={{ left, top }}
    >
      {plate.imageUrl ? (
        <Image
          src={plate.imageUrl}
          alt={plate.displayName + ' plate'}
          width={320}
          height={160}
          unoptimized
          className="mb-3 h-40 w-full object-contain"
        />
      ) : (
        <div className="mb-3 flex h-40 items-center justify-center bg-[var(--fill)]">
          No image
        </div>
      )}
      <h3 className="plate-name">{plate.displayName}</h3>
      <p className="id break-all font-mono text-[var(--ink-2)]">
        {plate.id}
        {parent ? ' · variant of ' + parent : ''}
      </p>
      <p className="my-3 text-sm">
        {state === 'loading'
          ? 'Loading plate details...'
          : state === 'error'
            ? 'Unable to load plate details. Click the plate to open it.'
            : (plate.checks.description.value ?? 'No description')}
      </p>
      {!state ? (
        <>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            {PLATE_CHECK_KEYS.map((key) => (
              <div key={key} className="flex min-w-0 items-start gap-1">
                <StatusIcon checkKey={key} check={plate.checks[key]} />
                <div className="min-w-0">
                  <dt>{CHECK_META[key].label}</dt>
                  <dd
                    title={plate.checks[key].value ?? undefined}
                    className="line-clamp-2 break-all"
                  >
                    {plate.checks[key].value ?? plate.checks[key].status}
                  </dd>
                </div>
              </div>
            ))}
          </dl>
          <div className="my-3 flex flex-wrap gap-1">
            {plate.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-[var(--fill)] px-2 py-1 text-xs"
              >
                {tag}
              </span>
            ))}
            {plate.tags.length > 3 ? (
              <span className="rounded-full bg-[var(--fill)] px-2 py-1 text-xs">
                +{plate.tags.length - 3}
              </span>
            ) : null}
          </div>
        </>
      ) : null}
      <p className="caption">Click to open</p>
    </aside>
  )
}
