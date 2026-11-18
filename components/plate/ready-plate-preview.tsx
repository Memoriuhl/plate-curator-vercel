'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PlateCardData, PlateCheckKey } from '@/lib/catalog/dashboard-types'
import { useDraftOverlay, usePlateDetail } from '@/lib/client/hooks'
import { CHECK_META } from './status-icon'
import { PlateHoverContent } from './plate-hover-card'
import { useLatestEnhancement } from './plate-image-preview'
import { EnhancementComparison } from '@/components/dashboard/enhanced-image-result'
import { cn } from '@/components/utils'

export type ReadyPreviewProps = {
  plate: PlateCardData
  anchor: HTMLElement
  immediate: boolean
  checkKey?: PlateCheckKey
  markerName?: string
  parent?: string
  onReady?: () => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

export function ReadyPlatePreview(props: ReadyPreviewProps) {
  return <PendingPreview key={`${props.plate.id}:${props.markerName ? 'marker' : props.checkKey ?? 'card'}:${props.immediate}`} {...props} />
}

function PendingPreview(props: ReadyPreviewProps) {
  const local = !!props.markerName || props.checkKey === 'tags' || props.checkKey === 'family' || props.checkKey === 'image'
  const { data } = usePlateDetail(local ? null : props.plate.id)
  const baselines = useMemo(() => data ? [data.plate] : [], [data])
  const [overlaid] = useDraftOverlay(baselines)
  const [intent, setIntent] = useState(props.immediate)
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    const delay = setTimeout(() => setIntent(true), props.checkKey || props.markerName ? 300 : 150)
    const fallback = setTimeout(() => setExpired(true), 1500)
    return () => { clearTimeout(delay); clearTimeout(fallback) }
  }, [props.checkKey, props.markerName])
  const onReady = props.onReady
  const visible = intent && (local || !!data || expired)
  useEffect(() => { if (visible) onReady?.() }, [visible, onReady])
  if (!props.anchor.isConnected || !visible) return null
  if (props.markerName) return <CheckTooltip plate={props.plate} anchor={props.anchor} loading={false} message={props.markerName + ', edited in your batch'} />
  if (props.checkKey) return <CheckTooltip {...props} plate={local ? props.plate : overlaid ?? props.plate} loading={!local && !data} />
  return <PlateHoverContent {...props} plate={overlaid ?? props.plate} state={data ? undefined : 'loading'} />
}

function shortenValue(value: string) {
  return value.length > 64 ? value.slice(0, 36) + '\u2026' + value.slice(-24) : value
}

export function CheckValue({ plate, checkKey, parent }: { plate: PlateCardData; checkKey: PlateCheckKey; parent?: string }) {
  const value = plate.checks[checkKey].value
  if (checkKey === 'tags') return plate.tags.length ? <div className="flex flex-wrap gap-1">{plate.tags.map(tag => <span className="rounded-full bg-[var(--fill)] px-2 py-0.5 text-[var(--tag-ink)]" key={tag}>{tag}</span>)}</div> : <>None</>
  if (checkKey === 'family') return <>{plate.templateFamily ? `${plate.templateFamily}${plate.templateRole ? ` · ${plate.templateRole === 'variant' && parent ? `variant of ${parent}` : plate.templateRole}` : ''}` : 'Missing'}</>
  if (checkKey === 'image') {
    const filename = plate.imageUrl?.split(/[?#]/, 1)[0].split('/').at(-1)
    return <>{filename ? shortenValue(filename) : 'Missing'}</>
  }
  if (!value) return <>Missing</>
  if (checkKey === 'link') return <>{shortenValue(value)}</>
  if (checkKey === 'funFacts') {
    const facts = value.split('\n').filter(Boolean)
    return <><p>{facts.length} {facts.length === 1 ? 'fact' : 'facts'}</p><p className="line-clamp-2">{facts[0]}</p></>
  }
  return <p className={checkKey === 'description' ? 'line-clamp-4' : undefined}>{value}</p>
}

function CheckTooltip({ plate, checkKey, parent, anchor, loading, message, onMouseEnter, onMouseLeave }: Omit<ReadyPreviewProps, 'immediate'> & { loading: boolean; message?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const [snapshot] = useState({ plate, loading })
  const enhancement = useLatestEnhancement(plate.id, checkKey === 'image')
  useLayoutEffect(() => {
    const place = () => {
      if (!ref.current) return
      const icon = anchor.getBoundingClientRect()
      const bounds = ref.current.getBoundingClientRect()
      setPosition({ left: Math.max(8, Math.min(icon.left + icon.width / 2 - bounds.width / 2, window.innerWidth - bounds.width - 8)), top: icon.top - bounds.height - 8 >= 8 ? icon.top - bounds.height - 8 : icon.bottom + 8 })
    }
    place()
    const observer = new ResizeObserver(place)
    if (ref.current) observer.observe(ref.current)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => { observer.disconnect(); window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place) }
  }, [anchor])
  return createPortal(<div ref={ref} role={enhancement ? 'dialog' : 'tooltip'} data-check-tooltip
    aria-label={enhancement ? `${plate.displayName} image enhancement` : undefined}
    onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
    className={cn('fixed z-50 rounded-[var(--radius-md)] bg-[var(--card)] p-3 text-xs text-[var(--ink)] shadow-xl ring-1 ring-[var(--border)]',
      enhancement?.suggestion.frames?.length ? 'w-[min(840px,calc(100vw-16px))]' : 'w-max max-w-72', !enhancement && 'pointer-events-none')}
    style={position}>
    {checkKey ? <>
      <p className="mb-1 font-medium">{CHECK_META[checkKey].label} <span className="font-normal text-[var(--ink-2)]">· {snapshot.plate.checks[checkKey].status}</span></p>
      {enhancement ? <EnhancementComparison key={enhancement.jobId} {...enhancement} plateName={plate.displayName} />
        : <div className="break-words">{snapshot.loading ? 'Loading…' : <CheckValue plate={snapshot.plate} checkKey={checkKey} parent={parent} />}</div>}
    </> : message}
  </div>, document.body)
}
