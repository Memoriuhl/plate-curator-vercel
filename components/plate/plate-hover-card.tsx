'use client'

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { hoverPosition } from '@/components/dashboard/grid-feel'
import { usePlateDetail, useDraftOverlay } from '@/lib/client/hooks'
import Image from 'next/image'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import { PLATE_CHECK_KEYS } from '@/lib/catalog/dashboard-types'
import { CHECK_META, StatusIcon } from '@/components/plate/status-icon'

type HoverCardProps = {
  plate: PlateCardData
  parent?: string
  left?: number
  top?: number
  anchor?: HTMLElement
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
  left = 8,
  top = 8,
  anchor,
  onMouseEnter,
  onMouseLeave,
  state,
}: HoverCardProps & { state?: 'loading' | 'error' }) {
  const card = useRef<HTMLElement>(null)
  const [position, setPosition] = useState({ left, top })
  useLayoutEffect(() => {
    if (!anchor || !card.current) return
    const element = card.current
    const reposition = () => {
      const bounds = element.getBoundingClientRect()
      const next = hoverPosition(anchor.getBoundingClientRect(), bounds.width, bounds.height, window.innerWidth, window.innerHeight)
      setPosition(current => current.left === next.left && current.top === next.top ? current : next)
    }
    reposition()
    const observer = new ResizeObserver(reposition)
    observer.observe(element)
    window.addEventListener('scroll', reposition, { passive: true, capture: true })
    window.addEventListener('resize', reposition)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [anchor])
  const facts = plate.checks.funFacts.value?.split('\n').map(fact => fact.trim()).filter(Boolean) ?? []
  const gridKeys = PLATE_CHECK_KEYS.filter(key => key !== 'description' && key !== 'funFacts')
  const content = (
    <aside
      id="plate-breakdown-preview"
      ref={card}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      role="tooltip"
      tabIndex={-1}
      aria-label={plate.displayName + ' preview'}
      className="fixed z-50 max-h-[calc(100dvh-16px)] w-[min(420px,calc(100vw-16px))] overflow-auto rounded-[var(--radius-lg)] bg-[var(--card)] p-4 text-[var(--ink)] shadow-xl"
      style={{ left: 0, top: 0, transform: `translate(${position.left}px, ${position.top}px)` }}
    >
      {state === 'loading' ? <div aria-label="Loading plate details" aria-busy="true" className="min-h-[420px] animate-pulse space-y-3"><div className="h-36 rounded bg-[var(--fill)]" /><div className="h-6 w-2/3 rounded bg-[var(--fill)]" /><div className="h-16 rounded bg-[var(--fill)]" /><div className="h-28 rounded bg-[var(--fill)]" /></div> : <>
      {plate.imageUrl ? (
        <Image
          src={plate.imageUrl}
          alt={plate.displayName + ' plate'}
          width={388}
          height={144}
          unoptimized
          className="mb-3 h-36 w-full object-contain"
        />
      ) : (
        <div className="mb-3 flex h-36 items-center justify-center bg-[var(--fill)]">
          No image
        </div>
      )}
      <h3 className="plate-name">{plate.displayName}</h3>
      <p className="id break-all font-mono text-[var(--ink-2)]">
        {plate.id}
        {parent ? ' · variant of ' + parent : ''}
      </p>
      {state === 'error' ? (
        <p className="my-3 text-sm">Unable to load plate details. Click the plate to open it.</p>
      ) : (
        <>
          <section aria-label="Description" className="mt-3">
            <h4 className="flex items-center gap-1 text-xs font-extrabold">
              <StatusIcon checkKey="description" check={plate.checks.description} />
              {CHECK_META.description.label}
            </h4>
            <p className="mt-1 text-sm">{plate.checks.description.value ?? 'No description'}</p>
          </section>
          <section aria-label="Fun facts" className="mt-3">
            <h4 className="flex items-center gap-1 text-xs font-extrabold">
              <StatusIcon checkKey="funFacts" check={plate.checks.funFacts} />
              {CHECK_META.funFacts.label}
            </h4>
            {facts.length ? (
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                {facts.map((fact, index) => <li key={index}>{fact}</li>)}
              </ul>
            ) : <p className="mt-1 text-sm text-[var(--ink-2)]">No fun facts yet</p>}
          </section>
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-[var(--hairline)] pt-3 text-xs">
            {gridKeys.map((key) => (
              <div key={key} className="flex min-w-0 items-start gap-1">
                <StatusIcon checkKey={key} check={plate.checks[key]} />
                <div className="min-w-0">
                  <dt className="font-extrabold">{CHECK_META[key].label}</dt>
                  <dd
                    title={plate.checks[key].value ?? undefined}
                    className={key === 'link' || key === 'image' ? 'truncate' : 'line-clamp-2 break-words'}
                  >
                    {plate.checks[key].value ?? plate.checks[key].status}
                  </dd>
                </div>
              </div>
            ))}
          </dl>
          {plate.tags.length ? (
            <div className="mt-3 flex flex-wrap gap-1">
              {plate.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-[var(--fill)] px-2 py-1 text-xs text-[var(--tag-ink)]"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </>
      )}
      <p className="caption mt-3">Click to open</p>
      </>}
    </aside>
  )
  return anchor ? createPortal(content, document.body) : content
}
