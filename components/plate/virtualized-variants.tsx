'use client'

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  defaultRangeExtractor,
  useWindowVirtualizer,
} from '@tanstack/react-virtual'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'

export function VirtualizedVariants({
  plates,
  renderPlate,
}: {
  plates: PlateCardData[]
  renderPlate: (plate: PlateCardData) => ReactNode
}) {
  const container = useRef<HTMLDivElement>(null)
  const [margin, setMargin] = useState(550)
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null)
  const virtualizer = useWindowVirtualizer({
    count: plates.length,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range)
      if (
        focusedIndex !== null &&
        focusedIndex < plates.length &&
        !indexes.includes(focusedIndex)
      )
        indexes.push(focusedIndex)
      return indexes.sort((a, b) => a - b)
    },
    initialRect: { width: 1440, height: 900 },
    estimateSize: () => 96,
    overscan: 2,
    scrollMargin: margin,
    getItemKey: (index) => plates[index].id,
  })
  useLayoutEffect(() => {
    const measure = () => {
      if (container.current)
        setMargin(
          container.current.getBoundingClientRect().top + window.scrollY,
        )
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (container.current) observer.observe(container.current)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, { passive: true })
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure)
    }
  }, [])
  return (
    <div
      ref={container}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocusedIndex(null)
      }}
      role="list"
      aria-label="Variants"
      className="relative"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={item.key}
          data-index={item.index}
          ref={virtualizer.measureElement}
          role="listitem"
          onFocusCapture={() => setFocusedIndex(item.index)}
          aria-posinset={item.index + 1}
          aria-setsize={plates.length}
          className="absolute top-0 left-0 w-full pb-3"
          style={{ transform: `translateY(${item.start - margin}px)` }}
        >
          {renderPlate(plates[item.index])}
        </div>
      ))}
    </div>
  )
}
