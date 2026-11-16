'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import { useBatch, useBatches } from '@/lib/client/hooks'
import { FamilyCard } from '@/components/plate/family-card'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { groupFamilies, matchesPlate } from './family-data'

const PlateHoverCard = dynamic(
  () => import('@/components/plate/plate-hover-card'),
)

export function useFamilyBatchOverlay() {
  const batches = useBatches(['open'], { mine: true })
  const detail = useBatch(batches.data?.[0]?.id ?? null)
  return useMemo(
    () =>
      new Map(
        detail.data?.plates
          .filter((item) => item.edit)
          .map((item) => [item.proposed.id, item.edit!.authorId]) ?? [],
      ),
    [detail.data],
  )
}

export function FamilyGrid({ plates }: { plates: PlateCardData[] }) {
  const params = useSearchParams()
  const pathname = usePathname()
  const changed = useFamilyBatchOverlay()
  const changedIds = useMemo(() => new Set(changed.keys()), [changed])
  const show = params.get('show') ?? 'all'
  const query = params.get('q') ?? ''
  const families = useMemo(() => groupFamilies(plates), [plates])
  const matches = (plate: PlateCardData) =>
    matchesPlate(plate, show, query, changedIds)
  const visible = families
    .map((family, index) => ({ ...family, number: index + 1 }))
    .filter((family) => [family.template, ...family.variants].some(matches))
  const container = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState({ columns: 3, margin: 420 })
  const [preview, setPreview] = useState<{
    plate: PlateCardData
    left: number
    top: number
  } | null>(null)
  const anchor = useRef<HTMLElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const close = () => {
    if (timer.current) clearTimeout(timer.current)
    anchor.current = null
    setPreview(null)
  }
  useEffect(() => {
    const resize = () =>
      setLayout({
        columns: window.innerWidth < 640 ? 1 : window.innerWidth < 1100 ? 2 : 3,
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
      const rect = element.getBoundingClientRect()
      setPreview((current) =>
        current
          ? {
              ...current,
              left: Math.max(
                8,
                Math.min(rect.right + 12, window.innerWidth - 388),
              ),
              top: Math.max(8, Math.min(rect.top, window.innerHeight - 720)),
            }
          : null,
      )
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
        ...rows[index].map((family) => 110 + family.variants.length * 82),
      ) + 16,
    overscan: 1,
    scrollMargin: layout.margin,
    getItemKey: (index) =>
      rows[index].map((family) => family.template.id).join('|'),
  })
  const virtualRows = virtualizer.getVirtualItems()
  function open(
    plate: PlateCardData,
    element: HTMLElement,
    immediate: boolean,
  ) {
    if (timer.current) clearTimeout(timer.current)
    anchor.current = element
    const rect = element.getBoundingClientRect()
    const left = Math.max(8, Math.min(rect.right + 12, window.innerWidth - 388))
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - 720))
    const reveal = () => setPreview({ plate, left, top })
    if (immediate) reveal()
    else timer.current = setTimeout(reveal, 180)
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
                    matches={matches}
                    onPreview={open}
                    onClosePreview={() => {
                      if (timer.current) clearTimeout(timer.current)
                      timer.current = setTimeout(close, 150)
                    }}
                    badge={(plate) =>
                      changed.has(plate.id) ? (
                        <Avatar
                          size="sm"
                          activity="changed"
                          aria-label="Changed in your batch"
                        >
                          <AvatarFallback>
                            {changed.get(plate.id)?.slice(0, 1).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
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
      {preview ? (
        <PlateHoverCard
          {...preview}
          parent={parent}
          onMouseEnter={() => {
            if (timer.current) clearTimeout(timer.current)
          }}
          onMouseLeave={close}
        />
      ) : null}
    </section>
  )
}
