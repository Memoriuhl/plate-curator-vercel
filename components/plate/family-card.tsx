'use client'

import { SelectionPlate, plateSelection } from '@/components/dashboard/plate-selection'
import { useSelectedBatchId } from '@/lib/client/hooks'

import Image from 'next/image'
import { preconnect } from 'react-dom'
import Link from 'next/link'
import { useEffect, useRef, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { IoStar } from 'react-icons/io5'
import { cn } from '@/components/utils'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import { CheckStrip } from './check-strip'
import { VirtualizedVariants } from './virtualized-variants'
import type { usePlateDrag } from '@/components/dashboard/use-plate-drag'
import { DragPlaceholder } from '@/components/dashboard/drag-preview'

export type FamilyCardProps = {
  template: PlateCardData
  variants: PlateCardData[]
  groupingNote?: string
  number?: number
  matches?: (plate: PlateCardData) => boolean
  badge?: (plate: PlateCardData) => ReactNode
  onPreview?: (
    plate: PlateCardData,
    element: HTMLElement,
    immediate: boolean,
  ) => void
  onClosePreview?: () => void
  onPreload?: (id: string) => void
  onCheck?: (plate: PlateCardData, key: import('@/lib/catalog/dashboard-types').PlateCheckKey, anchor: HTMLElement) => void
  onMarker?: (plate: PlateCardData, anchor: HTMLElement) => void
  onLeaveCheck?: () => void
  onDismissPreview?: () => void
  prefetchedIds?: Set<string>
  drag?: ReturnType<typeof usePlateDrag>
  onUndoDelete?: (plate: PlateCardData) => void
  undoPending?: boolean
  canEdit?: boolean
  last?: boolean
}

export function FamilyCard({
  template,
  variants,
  groupingNote,
  number,
  matches,
  badge,
  onPreview,
  onClosePreview,
  prefetchedIds,
  onPreload,
  onCheck,
  onMarker,
  onLeaveCheck,
  onDismissPreview,
  drag,
  onUndoDelete,
  undoPending,
  canEdit,
}: FamilyCardProps) {
  const batchId = useSelectedBatchId()
  const router = useRouter()
  const prefetched = useRef(new Set<string>())
  const previewBlocked = useRef(new Set<string>())
  function prefetch(id: string) {
    const ids = prefetchedIds ?? prefetched.current
    if (ids.has(id)) return
    ids.add(id)
    router.prefetch('/plates/' + id)
  }
  function preview(plate: PlateCardData, element: HTMLElement, immediate: boolean) {
    if (drag?.active || drag?.saving) return
    if (entranceRunning(element)) return
    onPreview?.(plate, element, immediate)
  }
  function entranceRunning(element: HTMLElement) {
    const plate = element.closest('[data-drag-variant]') ?? element.closest('article')
    return plate?.querySelector('[data-plate-image]')?.getAnimations?.().some(animation => animation.playState === 'running' || animation.pending)
  }
  const pointerDragging = !!drag?.active && !drag.active.keyboard && (drag.active.item.plate.id === template.id || variants.some(plate => plate.id === drag.active?.item.plate.id))
  const draggedId = pointerDragging ? drag?.active?.item.plate.id : undefined
  useEffect(() => {
    if (!pointerDragging || !draggedId) return
    previewBlocked.current.add(draggedId)
    const root = document.documentElement
    const previous = root.style.cursor
    root.style.cursor = 'grabbing'
    const style = document.createElement('style')
    style.textContent = '* { cursor: grabbing !important; }'
    document.head.append(style)
    return () => {
      root.style.cursor = previous
      style.remove()
    }
  }, [pointerDragging, draggedId])
  const target = drag?.active?.target
  const merge = target?.kind === 'merge' && target.familyId === template.id
  const invalidMerge = merge && (!drag?.canMerge || drag.active?.item.plate.id === template.id || variants.some(plate => plate.id === drag?.active?.item.plate.id))
  const placeholder = drag?.reflow?.placeholder
  const gapHeight = drag?.active?.geometry.height ?? 0
  if (number === 1 && template.imageUrl?.startsWith('https:'))
    preconnect(new URL(template.imageUrl).origin)
  function plateContent(plate: PlateCardData, small: boolean) {
    const width = small ? 84 : 140
    const height = small ? 42 : 70
    const marker = badge?.(plate)
    const item = { kind: small ? 'variant' as const : 'family' as const, plate }
    const href = '/plates/' + plate.id + (batchId !== null ? '?batch=' + encodeURIComponent(batchId) : '')
    if (small && placeholder?.kind === 'variant' && placeholder.id === plate.id) return <div key={plate.id} data-drag-variant={plate.id} data-reflow-key={'variant:' + plate.id}><DragPlaceholder height={gapHeight} variant /></div>
    return (
      <SelectionPlate key={plate.id} id={plate.id} disabled={!!plate.deleted || (!!matches && !matches(plate))}
        data-plate-row={plate.id}
        data-drag-handle-id={plate.id}
        aria-keyshortcuts={drag?.enabled && !plate.deleted ? "Space Enter Shift+Space" : "Space Enter"}
        title={drag?.handleTitle}
        onKeyDown={event => {
          if (event.target !== event.currentTarget) return
          if (event.key === ' ') event.preventDefault()
          if (entranceRunning(event.currentTarget)) return
          if (drag?.active?.keyboard || (event.key === ' ' && event.shiftKey)) {
            drag?.onKeyDown(item, event)
          } else if (event.key === ' ') {
            event.preventDefault()
            if (!plate.deleted && (!matches || matches(plate))) plateSelection.select(plate.id, { ctrlKey: true })
          } else if (event.key === 'Enter') {
            event.preventDefault()
            router.push(href)
          }
        }}
        data-drag-variant={small ? plate.id : undefined}
        data-reflow-key={small ? 'variant:' + plate.id : undefined}
        onPointerEnter={() => onPreload?.(plate.id)}
        onPointerOver={event => {
          if (event.buttons > 0) return
          const marker = (event.target as Element).closest<HTMLElement>('[data-batch-marker]')
          if (marker) {
            if (event.relatedTarget instanceof Node && marker.contains(event.relatedTarget)) return
            onDismissPreview?.()
            if (!drag?.active && !drag?.saving && !entranceRunning(marker)) onMarker?.(plate, marker)
            return
          }
          const icon = (event.target as Element).closest<HTMLElement>('[data-check]')
          if (!icon || !event.currentTarget.contains(icon)) {
            if ((event.target as Element).closest('[data-check-strip]')) onDismissPreview?.()
            return
          }
          if (event.relatedTarget instanceof Node && icon.contains(event.relatedTarget)) return
          onDismissPreview?.()
          if (!drag?.active && !drag?.saving && !entranceRunning(icon)) onCheck?.(plate, icon.dataset.check as import('@/lib/catalog/dashboard-types').PlateCheckKey, icon)
        }}
        onPointerOut={event => {
          const icon = (event.target as Element).closest('[data-check], [data-batch-marker]')
          if (icon && !(event.relatedTarget instanceof Node && icon.contains(event.relatedTarget))) onLeaveCheck?.()
        }}
        onPointerDownCapture={event => {
          if ((event.target as Element).closest('[data-plate-image]')) previewBlocked.current.add(plate.id)
          if (onDismissPreview) onDismissPreview()
          else onClosePreview?.()
        }}
        onPointerDown={event => {
          event.stopPropagation()
          if ((event.target as Element).closest('button, input')) return
          if (canEdit && !entranceRunning(event.currentTarget)) drag?.onPointerDown(item, event)
        }}
        className={cn(
          'relative flex items-start gap-3',
          drag?.enabled && !plate.deleted ? 'cursor-grab!' : 'cursor-pointer',
          plate.deleted && 'opacity-60 [&_h3]:line-through',
          matches && !matches(plate) && 'opacity-35',
        )}
      >
        {!small && number !== undefined ? <span aria-label={'Family order ' + number} className="caption absolute -top-3 -left-3 rounded-[var(--radius-sm)] bg-[var(--fill)] px-1 text-[var(--ink-2)]">{number}</span> : null}
        <Link
          href={href}
          data-plate-open
          tabIndex={-1}
          aria-hidden="true"
          aria-label={'Open ' + plate.displayName}
          prefetch={false}
          className="shrink-0 rounded-[var(--radius-sm)] focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
          onPointerEnter={() => prefetch(plate.id)}
          onFocus={() => prefetch(plate.id)}
          onBlur={onClosePreview}
        >
          <div
            data-plate-image
            onPointerEnter={event => {
              if (event.buttons > 0 || drag?.active || drag?.saving) {
                previewBlocked.current.add(plate.id)
                return
              }
              if (previewBlocked.current.has(plate.id)) return
              onLeaveCheck?.()
              preview(plate, event.currentTarget, false)
            }}
            onPointerLeave={() => {
              previewBlocked.current.delete(plate.id)
              onClosePreview?.()
            }}
            style={small ? { width, height } : { width: 'var(--family-image-width, 140px)', height: 'var(--family-image-height, 70px)' }}
            className="relative flex origin-top shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-[var(--fill)] text-[var(--ink-3)]"
          >
            {plate.imageUrl ? (
              <Image
                src={plate.imageUrl}
                alt={plate.displayName + ' plate'}
                width={width}
                height={height}
                loading={!small && number === 1 ? 'eager' : 'lazy'}
                fetchPriority={!small && number === 1 ? 'high' : 'auto'}
                unoptimized
                className="size-full object-contain"
              />
            ) : (
              <span className="caption">No image</span>
            )}
          </div>
        </Link>
        <div className="family-plate-details flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="plate-name min-w-0 whitespace-normal hyphens-auto [overflow-wrap:break-word]">
              <Link lang="en" title={plate.id} prefetch={false} href={href} onPointerEnter={() => prefetch(plate.id)} onFocus={() => prefetch(plate.id)} className="rounded-sm focus-visible:outline-2 focus-visible:outline-[var(--primary)]">{plate.displayName}</Link>
            </h3>
            {plate.isStandard ? (
              <span
                aria-label="Standard plate"
                title="Standard plate"
                className="text-[var(--warning)]"
              >
                <IoStar aria-hidden="true" />
              </span>
            ) : null}
          </div>
          <CheckStrip checks={plate.checks} />
          {plate.deleted && onUndoDelete && <button type="button" className="caption text-[var(--danger)] focus-visible:outline-2" disabled={!canEdit || undoPending} onClick={event => { event.stopPropagation(); onUndoDelete(plate) }}>Undo delete</button>}
        </div>
        {marker ? <span data-batch-marker>{marker}</span> : null}
      </SelectionPlate>
    )
  }
  if (placeholder?.kind === 'family' && placeholder.id === template.id) return <div data-drag-family={template.id} data-reflow-key={'family:' + template.id}><DragPlaceholder height={gapHeight} /></div>
  return (
    <article
      data-drag-family={template.id}
      data-reflow-key={'family:' + template.id}
      aria-label={template.displayName + ' family'}
      onClickCapture={event => drag?.suppressClick(event)}
      onDragStart={event => { if (drag?.enabled) event.preventDefault() }}
      className={cn('@container family-card relative flex origin-top min-w-0 cursor-pointer flex-col gap-3 rounded-[var(--radius-lg)] bg-[var(--card)] p-4 text-[var(--ink)]', merge && 'outline-2 outline-[var(--primary)]', invalidMerge && 'outline-dashed outline-[var(--danger)]')}
    >
      {plateContent(template, false)}
      {variants.length ? (
        <div className="mt-3 flex flex-col gap-2 pl-8">
          {variants.length >= 6 ? (
            <VirtualizedVariants
              plates={variants}
              familyId={template.id}
              drag={drag}
              renderPlate={(plate) => plateContent(plate, true)}
            />
          ) : (
            variants.map((plate) => plateContent(plate, true))
          )}
        </div>
      ) : null}
      {groupingNote ? (
        <p className="caption whitespace-normal break-words text-[var(--ink-2)]">
          {groupingNote}
        </p>
      ) : null}
    </article>
  )
}
