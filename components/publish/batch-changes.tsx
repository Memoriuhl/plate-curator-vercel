'use client'

import { useId, useMemo, useRef, useState } from 'react'
import Image from 'next/image'
import { PlateImageHover } from '@/components/plate/plate-image-preview'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import { IoChevronForward } from 'react-icons/io5'
import type { BatchDetail } from '@/lib/client/hooks'
import { JURISDICTIONS } from '@/lib/catalog/jurisdictions'
import { PlateChangeIcons } from '@/components/review/plate-change-icons'
import { cn } from '@/components/utils'
import { changeSummary, DiffTable, groupChanges } from '@/components/review/diff'

type Entry = BatchDetail['plates'][number]
type ChangedPlate = { entry: Entry; tags: string[]; summary: string }

export function changesByState(plates: Entry[]) {
  const changes = new Map<string, ChangedPlate>()
  for (const [tag, entries] of Object.entries(groupChanges(plates))) {
    for (const entry of entries) {
      const item = changes.get(entry.baseline.id) ?? { entry, tags: [], summary: changeSummary(entry.baseline, entry.proposed, entry.order).replaceAll(', ', ' \u00b7 ') }
      item.tags.push(tag)
      changes.set(entry.baseline.id, item)
    }
  }
  const states = new Map<string, ChangedPlate[]>()
  for (const plate of changes.values()) {
    const code = plate.entry.baseline.state
    const entries = states.get(code) ?? []
    entries.push(plate)
    states.set(code, entries)
  }
  return [...states].sort(([a], [b]) => a.localeCompare(b)).map(([code, entries]) => ({ code, plates: entries }))
}

function Thumbnail({ entry }: { entry: Entry }) {
  const url = entry.afterImageUrl ?? entry.beforeImageUrl
  return <span className={cn("flex h-12 w-24 shrink-0 items-center justify-center rounded-lg bg-[var(--fill)]", entry.proposed.deleted && "opacity-60")}>
    {url ? <PlateImageHover plateId={entry.baseline.id} plateName={entry.proposed.displayName} before={url}>
      <Image src={url} alt="" width={96} height={48} loading="lazy" unoptimized className="h-12 w-24 object-contain p-1" />
    </PlateImageHover> : <span className="text-xs text-muted-foreground">No image</span>}
  </span>
}

function StatePlates({ plates, batch }: { plates: ChangedPlate[]; batch: BatchDetail['batch'] }) {
  'use no memo'
  const container = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<string[]>([])
  const [focused, setFocused] = useState<number | null>(null)
  const id = useId()
  const virtualized = plates.length > 100
  const virtualizer = useVirtualizer({
    count: plates.length,
    getScrollElement: () => container.current,
    enabled: virtualized,
    estimateSize: () => 88,
    overscan: 4,
    initialRect: { width: 600, height: 560 },
    getItemKey: index => plates[index].entry.baseline.id,
    rangeExtractor: range => [...new Set([...defaultRangeExtractor(range), ...(focused === null ? [] : [focused])])].sort((a, b) => a - b),
  })
  function row(index: number, start?: number) {
    const { entry, summary } = plates[index]
    const open = expanded.includes(entry.baseline.id)
    return <div key={entry.baseline.id} data-index={index} ref={virtualized ? virtualizer.measureElement : undefined}
      className={virtualized ? 'absolute left-0 top-0 w-full pb-2' : 'pb-2'}
      style={start === undefined ? undefined : { transform: `translateY(${start}px)` }}
      onFocusCapture={() => setFocused(index)}>
      <div className="rounded-2xl bg-[var(--fill)] p-3">
        <button type="button" aria-expanded={open} aria-controls={open ? `${id}-${index}` : undefined} className="flex min-h-14 w-full items-center gap-3 text-left focus-visible:outline-2 focus-visible:outline-primary" onClick={() => setExpanded(ids => open ? ids.filter(value => value !== entry.baseline.id) : [...ids, entry.baseline.id])}>
          <IoChevronForward aria-hidden className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
          <Thumbnail entry={entry} />
          <span className="min-w-0 space-y-1" title={summary}>
            <strong className={cn('block truncate', entry.proposed.deleted && 'line-through opacity-60')}>{entry.proposed.displayName}</strong>
            <span className="sr-only">{summary}</span>
            <PlateChangeIcons entry={entry} />
          </span>
        </button>
        {open && <div id={`${id}-${index}`} className="mt-4"><DiffTable compact before={entry.baseline} after={entry.proposed} beforeImageUrl={entry.beforeImageUrl} afterImageUrl={entry.afterImageUrl} version={batch.baselineVersion} revision={batch.revision} positions={entry.order} order={batch.stateOrders[entry.baseline.state] ?? []} /></div>}
      </div>
    </div>
  }
  return <div ref={container} className={virtualized ? 'max-h-[560px] overflow-y-auto' : undefined} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null) }}>
    <div className={virtualized ? 'relative' : undefined} style={virtualized ? { height: virtualizer.getTotalSize() } : undefined}>
      {virtualized ? virtualizer.getVirtualItems().map(item => row(item.index, item.start)) : plates.map((_, index) => row(index))}
    </div>
  </div>
}

export function BatchChanges({ plates, batch }: { plates: Entry[]; batch: BatchDetail['batch'] }) {
  const groups = useMemo(() => changesByState(plates), [plates])
  const [expanded, setExpanded] = useState<string[]>([])
  const id = useId()
  return <div className="space-y-3">
    {groups.map(({ code, plates: entries }) => {
      const open = expanded.includes(code)
      return <section key={code} className="rounded-2xl bg-card">
        <h2><button type="button" aria-label={`${code} ${JURISDICTIONS[code] ?? code}, ${entries.length} plates changed`} aria-expanded={open} aria-controls={open ? `${id}-${code}` : undefined} className="flex w-full flex-wrap items-center gap-3 rounded-xl p-3 text-left focus-visible:outline-2 focus-visible:outline-primary" onClick={() => setExpanded(states => open ? states.filter(state => state !== code) : [...states, code])}>
          <IoChevronForward aria-hidden className={`transition-transform ${open ? 'rotate-90' : ''}`} />
          <span className="text-lg font-extrabold">{code}</span><span className="font-semibold">{JURISDICTIONS[code] ?? code}</span>
          <span className="text-xs text-muted-foreground">{entries.length} {entries.length === 1 ? 'plate' : 'plates'} changed</span>
          <span aria-hidden className="ml-auto flex -space-x-12">{entries.slice(0, 3).map(({ entry }) => <Thumbnail key={entry.baseline.id} entry={entry} />)}</span>
        </button></h2>
        {open && <div id={`${id}-${code}`} className="p-2"><StatePlates plates={entries} batch={batch} /></div>}
      </section>
    })}
  </div>
}
