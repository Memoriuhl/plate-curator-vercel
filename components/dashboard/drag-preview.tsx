'use client'

import { createPortal } from 'react-dom'
import { useCallback, useState } from 'react'
import Image from 'next/image'
import { cn } from '@/components/utils'
import type { DragItem } from './drop-targets'
import type { DragGeometry } from './drag-geometry'

export function DragPreview({ item, x, y, geometry, variantCount = 0 }: { item: DragItem; x: number; y: number; geometry?: DragGeometry; variantCount?: number }) {
  const [height, setHeight] = useState(0)
  const measurePreview = useCallback((element: HTMLDivElement | null) => {
    if (element) setHeight(element.offsetHeight)
  }, [])
  const offsetY = Math.max(0, Math.min(geometry?.offsetY ?? 0, height))
  if (typeof document === 'undefined') return null
  return createPortal(
    <div ref={measurePreview} aria-hidden="true" data-drag-lifted className="pointer-events-none fixed top-0 left-0 z-50 flex origin-top-left flex-col items-center gap-3 overflow-hidden rounded-[var(--radius-lg)] bg-[var(--card)] p-4 text-[var(--ink)] shadow-xl ring-1 ring-[var(--line)]" style={{ width: geometry?.width ?? 220, transformOrigin: `${geometry?.offsetX ?? 0}px ${offsetY}px`, transform: `translate3d(${x - (geometry?.offsetX ?? 0)}px, ${y - offsetY}px, 0) scale(1.03)` }}>
      <style>{'body.plate-dragging, body.plate-dragging * { cursor: grabbing !important; user-select: none; }'}</style>
      <div className="flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-[var(--fill)]" style={{ width: geometry?.imageWidth ?? 140, height: geometry?.imageHeight ?? 70 }}>
        {item.plate.imageUrl ? <Image src={item.plate.imageUrl} alt="" width={geometry?.imageWidth ?? 140} height={geometry?.imageHeight ?? 70} unoptimized className="size-full object-contain" /> : <span className="caption">No image</span>}
      </div>
      <div className="flex w-full items-center gap-2">
        <strong className="plate-name min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere]">{item.plate.displayName}</strong>
        {item.kind === 'family' && variantCount > 0 ? <span className="caption shrink-0 rounded-full bg-[var(--fill)] px-2 py-1">{variantCount} {variantCount === 1 ? 'variant' : 'variants'}</span> : null}
      </div>
    </div>, document.body,
  )
}

export function DragPlaceholder({ height, variant = false }: { height: number; variant?: boolean }) {
  return <div aria-hidden="true" data-drag-placeholder={variant ? 'variant' : 'family'} className={cn('w-full border border-dashed border-[var(--line)] bg-[var(--fill)]', variant ? 'rounded-[var(--radius-sm)]' : 'rounded-[var(--radius-lg)]')} style={{ height }} />
}

export function DropIndicator({ active, vertical = false, end = false }: { active: boolean; vertical?: boolean; end?: boolean }) {
  return <span aria-hidden="true" className={cn('pointer-events-none absolute z-10 rounded-full bg-[var(--primary)]', vertical ? cn('inset-y-0 w-[3px]', end ? '-right-2' : '-left-2') : cn('inset-x-0 h-[3px]', end ? '-bottom-2' : '-top-2'), !active && 'hidden')} />
}
