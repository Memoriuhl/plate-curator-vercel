'use client'

import { createPortal } from 'react-dom'
import { cn } from '@/components/utils'
import type { DragItem } from './drop-targets'

export function DragPreview({ item, x, y }: { item: DragItem; x: number; y: number }) {
  if (typeof document === 'undefined') return null
  return createPortal(
    <div aria-hidden="true" className="pointer-events-none fixed top-0 left-0 z-50 max-w-64 rounded-[var(--radius-md)] bg-[var(--card)] p-3 text-[var(--ink)] shadow-xl ring-2 ring-[var(--primary)]" style={{ transform: `translate3d(${x + 12}px, ${y + 12}px, 0)` }}>
      <style>{'body.plate-dragging, body.plate-dragging * { cursor: grabbing !important; }'}</style>
      <strong>{item.plate.displayName}</strong>
      <p className="caption">{item.kind === 'family' ? 'Moving family' : 'Moving variant'}</p>
    </div>, document.body,
  )
}

export function DropIndicator({ active, vertical = false }: { active: boolean; vertical?: boolean }) {
  return <span aria-hidden="true" className={cn('pointer-events-none absolute z-10 rounded-full bg-[var(--primary)]', vertical ? 'inset-y-0 -left-2 w-[3px]' : 'inset-x-0 -top-2 h-[3px]', !active && 'hidden')} />
}
