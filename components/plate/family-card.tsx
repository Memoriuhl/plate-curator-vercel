'use client'

import Image from 'next/image'
import { preconnect } from 'react-dom'
import Link from 'next/link'
import { useRef, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  IoReorderThreeOutline,
  IoStar,
  IoInformationCircleOutline,
} from 'react-icons/io5'
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
  canEdit,
}: FamilyCardProps) {
  const router = useRouter()
  const prefetched = useRef(new Set<string>())
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
  const target = drag?.active?.target
  const merge = target?.kind === 'merge' && target.familyId === template.id
  const invalidMerge = merge && (!drag?.canMerge || drag.active?.item.plate.id === template.id || variants.some(plate => plate.id === drag?.active?.item.plate.id))
  const item = { kind: 'family' as const, plate: template }
  const placeholder = drag?.reflow?.placeholder
  const gapHeight = drag?.active?.geometry.height ?? 0
  if (number === 1 && template.imageUrl?.startsWith('https:'))
    preconnect(new URL(template.imageUrl).origin)
  function plateContent(plate: PlateCardData, small: boolean) {
    const width = small ? 84 : 140
    const height = small ? 42 : 70
    const marker = badge?.(plate)
    if (small && placeholder?.kind === 'variant' && placeholder.id === plate.id) return <div key={plate.id} data-drag-variant={plate.id} data-reflow-key={'variant:' + plate.id}><DragPlaceholder height={gapHeight} variant /></div>
    return (
      <div
        key={plate.id}
        data-drag-variant={small ? plate.id : undefined}
        data-reflow-key={small ? 'variant:' + plate.id : undefined}
        onPointerEnter={() => onPreload?.(plate.id)}
        onPointerOver={event => {
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
        onPointerDown={small ? event => {
          event.stopPropagation()
          if ((event.target as Element).closest('button') && !(event.target as Element).closest('[data-variant-handle]')) return
          if (!entranceRunning(event.currentTarget)) drag?.onPointerDown({ kind: 'variant', plate }, event)
        } : undefined}
        className={cn(
          'relative flex items-start gap-3',
          matches && !matches(plate) && 'opacity-35',
        )}
      >
        {small && canEdit ? <button type="button" data-variant-handle data-drag-handle-id={plate.id} aria-label={'Move ' + plate.displayName} aria-disabled={!drag?.enabled} title={drag?.handleTitle} className={cn('shrink-0 rounded-sm focus-visible:outline-2 focus-visible:outline-[var(--primary)]', drag?.enabled && 'touch-none cursor-grab')} onKeyDown={event => {
          if (!entranceRunning(event.currentTarget)) drag?.onKeyDown({ kind: 'variant', plate }, event)
        }}><IoReorderThreeOutline aria-hidden="true" /></button> : null}
        <Link
          prefetch={false}
          href={'/plates/' + plate.id}
          className={cn('flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-[var(--radius-sm)] focus-visible:outline-2 focus-visible:outline-[var(--primary)]', !small && 'flex-col @min-[340px]:flex-row')}
          onPointerEnter={() => prefetch(plate.id)}
          onFocus={(event) => {
            prefetch(plate.id)
            preview(plate, event.currentTarget.querySelector('[data-plate-image]') as HTMLElement, true)
          }}
          onBlur={onClosePreview}
        >
          <div
            data-plate-image
            onMouseEnter={event => {
              onLeaveCheck?.()
              preview(plate, event.currentTarget, false)
            }}
            onMouseLeave={onClosePreview}
            style={{ width, height }}
            className="flex origin-top shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-[var(--fill)] text-[var(--ink-3)]"
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
          <div className="flex w-full min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-start justify-between gap-2">
              <h3 className="plate-name min-w-0 whitespace-normal [overflow-wrap:anywhere]">
                {plate.displayName}
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
            <p className="id break-all font-mono text-[var(--ink-2)]">
              {plate.id}
            </p>
            <CheckStrip checks={plate.checks} />
          </div>
          {marker ? <span data-batch-marker>{marker}</span> : null}
        </Link>
        {onPreview ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={'Preview ' + plate.displayName}
            onClick={(event) => preview(plate, event.currentTarget, true)}
            onMouseEnter={(event) => preview(plate, event.currentTarget, false)}
            onMouseLeave={onClosePreview}
            onFocus={(event) => preview(plate, event.currentTarget, true)}
            onBlur={onClosePreview}
            className="absolute right-0 bottom-0 text-[var(--ink-2)]"
          >
            <IoInformationCircleOutline />
          </button>
        ) : null}
      </div>
    )
  }
  if (placeholder?.kind === 'family' && placeholder.id === template.id) return <div data-drag-family={template.id} data-reflow-key={'family:' + template.id}><DragPlaceholder height={gapHeight} /></div>
  return (
    <article
      data-drag-family={template.id}
      data-reflow-key={'family:' + template.id}
      aria-label={template.displayName + ' family'}
      onPointerDown={event => {
        if ((event.target as Element).closest('button') && !(event.target as Element).closest('[data-family-handle]')) return
        if (!entranceRunning(event.currentTarget)) drag?.onPointerDown(item, event)
      }}
      onClickCapture={event => drag?.suppressClick(event)}
      onDragStart={event => { if (drag?.enabled) event.preventDefault() }}
      className={cn('@container relative flex origin-top min-w-0 cursor-pointer flex-col gap-3 rounded-[var(--radius-lg)] bg-[var(--card)] p-4 text-[var(--ink)]', merge && 'outline-2 outline-[var(--primary)]', invalidMerge && 'outline-dashed outline-[var(--danger)]')}
    >
      <div className="flex items-start gap-3">
        {canEdit ? <button
          type="button"
          data-family-handle
          data-drag-handle-id={template.id}
          aria-label={'Move ' + template.displayName + ' family'}
          aria-disabled={!drag?.enabled}
          title={drag?.handleTitle}
          onKeyDown={event => { if (!entranceRunning(event.currentTarget)) drag?.onKeyDown(item, event) }}
          className={cn('flex shrink-0 flex-col items-center rounded-[var(--radius-sm)] bg-[var(--fill)] p-1 text-[var(--ink-3)] focus-visible:outline-2 focus-visible:outline-[var(--primary)]', drag?.enabled && 'touch-none cursor-grab')}
        ><IoReorderThreeOutline size={20} aria-hidden="true" />{number}</button> : <span
          aria-hidden="true"
          className="flex shrink-0 flex-col items-center rounded-[var(--radius-sm)] bg-[var(--fill)] p-1 text-[var(--ink-3)]"
        >
          <IoReorderThreeOutline size={20} />
          {number}
        </span>}
        <div className="min-w-0 flex-1">{plateContent(template, false)}</div>
      </div>
      {variants.length ? (
        <div className="mt-3 flex flex-col gap-3 pl-8">
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
