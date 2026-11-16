'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { familyColumns } from './grid-feel'
import { useGridEntrance } from './use-grid-entrance'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import { useDraftOverlay, useEditPlate, useMe, useReorderState, usePreloadPlateDetail } from '@/lib/client/hooks'
import { useSWRConfig } from 'swr'
import { usePlateDrag } from './use-plate-drag'
import { collectDragTargets } from './drag-target-elements'
import { DragPreview } from './drag-preview'
import { FamilyCard } from '@/components/plate/family-card'
import { UserAvatar, userAvatarName } from '@/components/app/user-avatar'
import { useSession } from '@/lib/client/session'
import {
  groupFamilies,
  matchesPlate,
  expandFamilyPlate,
  type FamilyPlate,
} from './family-data'

import { ReadyPlatePreview } from '@/components/plate/ready-plate-preview'
import type { PlateCheckKey } from '@/lib/catalog/dashboard-types'

export function useFamilyBatchOverlay(plates: FamilyPlate[]) {
  const baselines = useMemo(() => plates.map(expandFamilyPlate), [plates])
  return useDraftOverlay(baselines)
}

export function FamilyGrid({ plates }: { plates: FamilyPlate[] }) {
  const params = useSearchParams()
  const pathname = usePathname()
  const overlaid = useFamilyBatchOverlay(plates)
  const changedIds = useMemo(
    () =>
      new Set(
        overlaid
          .filter((plate) => plate.changedInBatch)
          .map((plate) => plate.id),
      ),
    [overlaid],
  )
  const show = params.get('show') ?? 'all'
  const query = params.get('q') ?? ''
  const baselineFamilies = useMemo(() => groupFamilies(overlaid), [overlaid])
  const matches = (plate: PlateCardData) =>
    matchesPlate(plate, show, query, changedIds)
  const container = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState({ columns: 5, margin: 420, ready: false })
  const [preview, setPreview] = useState<{
    plate: PlateCardData
    anchor: HTMLElement
    immediate: boolean
    checkKey?: PlateCheckKey
    markerName?: string
  } | null>(null)
  useGridEntrance(container, layout.ready, pathname)
  const opened = useRef(false)
  const preload = usePreloadPlateDetail()
  const anchor = useRef<HTMLElement | null>(null)
  const [prefetchedIds] = useState(() => new Set<string>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const close = () => {
    if (timer.current) clearTimeout(timer.current)
    anchor.current = null
    setPreview(null)
  }
  const { user } = useSession()
  const me = useMe()
  const edits = useEditPlate()
  const ordering = useReorderState()
  const { mutate } = useSWRConfig()
  const canEdit = me.data?.role === 'editor' || me.data?.role === 'owner'
  const drag = usePlateDrag({
    families: baselineFamilies, canEdit, show, query, edits, ordering,
    targets: () => collectDragTargets(container.current, baselineFamilies),
    closePreview: close,
    reload: () => mutate(key => typeof key === 'string' && key.startsWith('/api/batches')),
  })
  const families = useMemo(() => {
    if (!drag.optimisticOrder && !drag.optimisticEdit) return baselineFamilies
    const positions = new Map(drag.optimisticOrder?.map((id, index) => [id, index]))
    return groupFamilies(overlaid.map(plate => ({
      ...plate,
      ...(drag.optimisticEdit?.plateId === plate.id ? drag.optimisticEdit.fields : {}),
      sortOrder: positions.get(plate.id) ?? plate.sortOrder,
    })))
  }, [baselineFamilies, overlaid, drag.optimisticOrder, drag.optimisticEdit])
  const visible = families
    .map((family, index) => ({ ...family, number: index + 1 }))
    .filter((family) => [family.template, ...family.variants].some(matches))
  useLayoutEffect(() => {
    const resize = () =>
      setLayout({
        columns: familyColumns(window.innerWidth),
        ready: true,
        margin:
          (container.current?.getBoundingClientRect().top ?? 0) +
          window.scrollY,
      })
    resize()
    const observer = new ResizeObserver(resize)
    if (container.current) observer.observe(container.current)
    window.addEventListener('resize', resize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [visible.length])
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    const dismissPointer = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('[role=tooltip]')
      )
        close()
    }
    window.addEventListener('keydown', dismiss)
    const reposition = () => {
      const element = anchor.current
      if (!element?.isConnected) {
        setPreview(null)
        return
      }
    }
    window.addEventListener('scroll', reposition, { passive: true })
    window.addEventListener('pointerdown', dismissPointer)
    return () => {
      if (timer.current) clearTimeout(timer.current)
      window.removeEventListener('keydown', dismiss)
      window.removeEventListener('scroll', reposition)
      window.removeEventListener('pointerdown', dismissPointer)
    }
  }, [])
  const rows = Array.from(
    { length: Math.ceil(visible.length / layout.columns) },
    (_, index) =>
      visible.slice(index * layout.columns, (index + 1) * layout.columns),
  )
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    initialRect: { width: 1440, height: 900 },
    estimateSize: (index) =>
      Math.max(
        ...rows[index].map((family) =>
          210 + family.variants.length * 104,
        ),
      ) + 16,
    overscan: 1,
    scrollMargin: layout.margin,
    getItemKey: (index) =>
      rows[index].map((family) => family.template.id).join('|'),
  })
  const virtualRows = virtualizer.getVirtualItems()
  const keyboardSource = useRef<string | null>(null)
  useEffect(() => {
    if (drag.active?.keyboard) keyboardSource.current = drag.active.item.plate.id
    if (drag.active || drag.saving || !keyboardSource.current) return
    const id = keyboardSource.current
    keyboardSource.current = null
    const index = families.findIndex(family => family.template.id === id || family.variants.some(plate => plate.id === id))
    if (index >= 0) virtualizer.scrollToIndex(Math.floor(index / layout.columns), { align: 'auto' })
    const frame = requestAnimationFrame(() => {
      Array.from(container.current?.querySelectorAll<HTMLElement>('[data-drag-handle-id]') ?? []).find(handle => handle.dataset.dragHandleId === id)?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [drag.active, drag.saving, families, virtualizer, layout.columns])
  const keyboardSlot = drag.active?.keyboard && drag.active.target?.kind === 'family-slot' ? drag.active.target.index : null
  useEffect(() => {
    if (keyboardSlot === null) return
    virtualizer.scrollToIndex(Math.floor(Math.min(keyboardSlot, visible.length - 1) / layout.columns), { align: 'auto' })
  }, [keyboardSlot, virtualizer, visible.length, layout.columns])
  function open(
    plate: PlateCardData,
    element: HTMLElement,
    immediate: boolean,
  ) {
    if (drag.active || drag.saving) return
    if (timer.current) clearTimeout(timer.current)
    opened.current = false
    anchor.current = element
    preload(plate.id)
    if (element.isConnected) setPreview({ plate, anchor: element, immediate })
  }
  const parent = preview
    ? families.find((family) =>
        family.variants.some((plate) => plate.id === preview.plate.id),
      )?.template.displayName
    : undefined
  return (
    <section aria-label="Plate families" id="families">
      {!visible.length ? (
        <div className="py-12 text-center">
          <p>No plates match</p>
          <Link href={pathname}>Clear filters</Link>
        </div>
      ) : (
        <>
          <div
            ref={container}
            className="relative"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualRows.map((row) => (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 grid w-full items-start gap-4 pb-4"
                style={{
                  gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`,
                  transform: `translateY(${row.start - layout.margin}px)`,
                }}
              >
                {rows[row.index].map((family) => (
                  <FamilyCard
                    key={family.template.id}
                    {...family}
                    drag={drag}
                    canEdit={canEdit}
                    last={family.number === families.length}
                    matches={matches}
                    prefetchedIds={prefetchedIds}
                    onPreview={open}
                    onPreload={preload}
                    onDismissPreview={close}
                    onLeaveCheck={close}
                    onMarker={(plate, element) => {
                      if (drag.active || drag.saving) return
                      opened.current = false
                      anchor.current = element
                      setPreview({ plate, anchor: element, immediate: false, markerName: userAvatarName(user) })
                    }}
                    onCheck={(plate, checkKey, element) => {
                      if (drag.active || drag.saving) return
                      opened.current = false
                      anchor.current = element
                      setPreview({ plate, anchor: element, immediate: false, checkKey })
                    }}
                    onClosePreview={() => {
                      if (!opened.current) { close(); return }
                      if (timer.current) clearTimeout(timer.current)
                      timer.current = setTimeout(close, 150)
                    }}
                    badge={(plate) =>
                      changedIds.has(plate.id) && user ? (
                        <UserAvatar user={user} size="sm" activity="changed" aria-label={userAvatarName(user) + ', edited in your batch'} />
                      ) : null
                    }
                  />
                ))}
              </div>
            ))}
          </div>
          <p className="caption py-4 text-center" aria-live="polite">
            Showing families {visible.length ? 1 : 0}–{visible.length} of{' '}
            {families.length}
          </p>
        </>
      )}
      <Suspense fallback={null}>
        {preview && !drag.active && !drag.saving ? (
          <ReadyPlatePreview
            {...preview}
            onReady={() => { opened.current = true }}
            parent={parent}
            onMouseEnter={() => {
              if (timer.current) clearTimeout(timer.current)
            }}
            onMouseLeave={() => {
              timer.current = setTimeout(close, 150)
            }}
          />
        ) : null}
      </Suspense>
      <p className="sr-only" aria-live="assertive" aria-atomic="true">{drag.announcement}</p>
      {drag.announcement && !drag.active ? <p className="caption py-2" role="status">{drag.announcement}</p> : null}
      {drag.active ? <DragPreview item={drag.active.item} x={drag.active.x} y={drag.active.y} /> : null}
    </section>
  )
}
