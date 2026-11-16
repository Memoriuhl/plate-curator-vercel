'use client'

import { createPortal } from 'react-dom'
import Image from 'next/image'
import { cn } from '@/components/utils'
import type { DragItem } from './drop-targets'
import type { DragGeometry } from './drag-geometry'

export function DragPreview({ item, x, y, geometry }: { item: DragItem; x: number; y: number; geometry?: DragGeometry }) {
  if (typeof document === 'undefined') return null
  return createPortal(
    <div aria-hidden="true" data-drag-lifted className="pointer-events-none fixed top-0 left-0 z-50 flex origin-top-left flex-col items-center gap-3 overflow-hidden rounded-[var(--radius-lg)] bg-[var(--card)] p-4 text-[var(--ink)] shadow-xl ring-1 ring-[var(--line)]" style={{ width: geometry?.width ?? 220, minHeight: geometry?.height, transformOrigin: `${geometry?.offsetX ?? 0}px ${geometry?.offsetY ?? 0}px`, transform: `translate3d(${x - (geometry?.offsetX ?? 0)}px, ${y - (geometry?.offsetY ?? 0)}px, 0) scale(1.03)` }}>
      <style>{'body.plate-dragging, body.plate-dragging * { cursor: grabbing !important; user-select: none; }'}</style>
      <div className="flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-[var(--fill)]" style={{ width: geometry?.imageWidth ?? 140, height: geometry?.imageHeight ?? 70 }}>
        {item.plate.imageUrl ? <Image src={item.plate.imageUrl} alt="" width={geometry?.imageWidth ?? 140} height={geometry?.imageHeight ?? 70} unoptimized className="size-full object-contain" /> : <span className="caption">No image</span>}
      </div>
      <strong className="plate-name w-full whitespace-normal [overflow-wrap:anywhere]">{item.plate.displayName}</strong>
    </div>, document.body,
  )
}

export function DragPlaceholder({ height, variant = false }: { height: number; variant?: boolean }) {
  return <div aria-hidden="true" data-drag-placeholder={variant ? 'variant' : 'family'} className={cn('w-full border border-dashed border-[var(--line)] bg-[var(--fill)]', variant ? 'rounded-[var(--radius-sm)]' : 'rounded-[var(--radius-lg)]')} style={{ height }} />
}

export function DropIndicator({ active, vertical = false, end = false }: { active: boolean; vertical?: boolean; end?: boolean }) {
  return <span aria-hidden="true" className={cn('pointer-events-none absolute z-10 rounded-full bg-[var(--primary)]', vertical ? cn('inset-y-0 w-[3px]', end ? '-right-2' : '-left-2') : cn('inset-x-0 h-[3px]', end ? '-bottom-2' : '-top-2'), !active && 'hidden')} />
}
