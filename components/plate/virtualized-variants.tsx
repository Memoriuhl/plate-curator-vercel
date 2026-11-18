'use client'

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import type { usePlateDrag } from '@/components/dashboard/use-plate-drag'
import {
  revealVariantRow,
  variantListCap,
  VARIANT_ROW_HEIGHT,
  VARIANT_ROW_GAP,
} from '@/components/dashboard/variant-list-layout'

/**
 * Render a capped, scrollable set of variant rows while retaining focused and measured
 * rows.
 */
export function VirtualizedVariants({
  plates,
  renderPlate,
  familyId,
  drag,
  focusPlateId,
}: {
  plates: PlateCardData[]
  renderPlate: (plate: PlateCardData) => ReactNode
  familyId: string
  drag?: ReturnType<typeof usePlateDrag>
  focusPlateId?: string
}) {
  // Let TanStack Virtual update its mutable DOM measurements on render.
  'use no memo'

  const container = useRef<HTMLDivElement>(null)
  const [cap, setCap] = useState<number>()
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const virtualized = plates.length > 12
  const focusedIndex = plates.findIndex((plate) => plate.id === focusedId)
  const targetIndex = focusPlateId
    ? plates.findIndex((plate) => plate.id === focusPlateId)
    : -1
  const keyboard =
    drag?.active?.keyboard &&
    drag.active.target?.kind === 'variant-slot' &&
    drag.active.target.familyId === familyId
  const gapIndex = keyboard
    ? plates.findIndex((plate) => plate.id === drag.active!.item.plate.id)
    : -1
  const virtualizer = useVirtualizer({
    count: plates.length,
    /** Provide the variant list container as the virtualizer's scroll surface. */
    getScrollElement: () => container.current,
    enabled: virtualized,
    /** Include visible rows and rows needed to measure the cap or preserve focus. */
    rangeExtractor: (range) =>
      [
        ...new Set([
          ...defaultRangeExtractor(range),
          ...Array.from(
            { length: Math.min(6, plates.length) },
            (_, index) => index
          ),
          focusedIndex,
          gapIndex,
          targetIndex,
        ]),
      ]
        .filter((index) => index >= 0)
        .sort((a, b) => a - b),
    initialRect: {
      width: 240,
      height: 5.5 * VARIANT_ROW_HEIGHT + 5 * VARIANT_ROW_GAP,
    },
    /** Give the virtualizer the standard variant row height before measurement. */
    estimateSize: () => VARIANT_ROW_HEIGHT,
    gap: VARIANT_ROW_GAP,
    overscan: 2,
    /** Use the plate ID as the row key so reordering preserves row identity. */
    getItemKey: (index) => plates[index].id,
  })
  const items = virtualizer.getVirtualItems()
  const measurementIdentity = items
    .map((item) => `${item.index}:${item.start}:${item.size}`)
    .join('|')
  useLayoutEffect(() => {
    const list = container.current
    if (!list) return
    const rows = Array.from(
      list.querySelectorAll<HTMLElement>('[data-variant-index]')
    )
      .filter((row) => Number(row.dataset.variantIndex) < 6)
      .sort(
        (a, b) =>
          Number(a.dataset.variantIndex) - Number(b.dataset.variantIndex)
      )
    /** Recompute the capped viewport after the measured variant rows change. */
    const measure = () => {
      const next = variantListCap(
        rows.map((row) => {
          const rect = row.getBoundingClientRect()
          return { start: rect.top, size: rect.height }
        })
      )
      setCap((previous) => (previous === next ? previous : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    rows.forEach((row) => observer.observe(row))
    return () => observer.disconnect()
  }, [plates, measurementIdentity])
  useLayoutEffect(() => {
    const list = container.current
    if (!list || gapIndex < 0) return
    if (virtualized) virtualizer.scrollToIndex(gapIndex, { align: 'auto' })
    const row = list.querySelector<HTMLElement>(
      `[data-variant-index="${gapIndex}"]`
    )
    if (row) revealVariantRow(list, row)
  }, [gapIndex, virtualized, virtualizer, cap])
  /** Position and render one variant row at its virtualized offset. */
  function row(index: number, start?: number) {
    return (
      <div
        key={plates[index].id}
        data-index={index}
        data-variant-index={index}
        ref={virtualized ? virtualizer.measureElement : undefined}
        role="listitem"
        aria-posinset={index + 1}
        aria-setsize={plates.length}
        className={virtualized ? 'absolute top-0 left-0 w-full' : undefined}
        style={
          start === undefined
            ? undefined
            : { transform: `translateY(${start}px)` }
        }
        onFocusCapture={(event) => {
          setFocusedId(plates[index].id)
          if (container.current)
            revealVariantRow(container.current, event.currentTarget)
        }}
      >
        {renderPlate(plates[index])}
      </div>
    )
  }
  return (
    <div
      ref={container}
      data-variant-scroll={familyId}
      tabIndex={0}
      role="list"
      aria-label="Variants"
      className="min-h-0 overflow-y-auto focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
      style={{ height: cap }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !keyboard)
          setFocusedId(null)
      }}
    >
      <div
        className={virtualized ? 'relative' : 'flex flex-col gap-2'}
        style={virtualized ? { height: virtualizer.getTotalSize() } : undefined}
      >
        {virtualized
          ? items.map((item) => row(item.index, item.start))
          : plates.map((_, index) => row(index))}
      </div>
    </div>
  )
}
