'use client'

import { Button } from '@/components/ui/button'
import { useStandardConfirmation } from '@/components/plate/standard-confirmation'
import { plateSelection, useSelectionKeyboard, SelectionPresence } from './plate-selection'
import { SelectionBar } from './selection-bar'
import dynamic from 'next/dynamic'
import { FilterBar } from './filter-bar'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { familyColumns } from './grid-feel'
import { useGridEntrance } from './use-grid-entrance'
import { useDragFlip } from './use-drag-flip'
import { estimatedFamilyHeight } from './variant-list-layout'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import { useWorkspaceBatch, useDraftOverlay, useEditPlate, useMe, useReorderState, usePreloadPlateDetail } from '@/lib/client/hooks'
import { useSWRConfig } from 'swr'
import { usePlateDrag } from './use-plate-drag'
import { collectDragTargets } from './drag-target-elements'
import { DragPreview } from './drag-preview'
import { Conflict, type Issue } from '@/components/plate/edit-conflict'
import { FamilyCard } from '@/components/plate/family-card'
import { UserAvatar, userAvatarName } from '@/components/app/user-avatar'
import { useSession } from '@/lib/client/session'
import {
  groupFamilies,
  attachedFamilyIds,
  filterCounts,
  matchesPlate,
  plateIdsForCheck,
  expandFamilyPlate,
  type FamilyPlate,
} from './family-data'

import type { PlateCheckKey } from '@/lib/catalog/dashboard-types'

const ReadyPlatePreview = dynamic(
  () => import('@/components/plate/ready-plate-preview').then(module => module.ReadyPlatePreview),
  { loading: () => null },
)

export function useFamilyBatchOverlay(plates: FamilyPlate[]) {
  const baselines = useMemo(() => plates.map(expandFamilyPlate), [plates])
  return useDraftOverlay(baselines)
}

export function FamilyGrid({ plates, code, onSelectGroup }: {
  plates: FamilyPlate[]
  code?: string
  onSelectGroup?(key: string, ids: string[]): void
}) {
  const params = useSearchParams()
  const pathname = usePathname()
  const latestOverlay = useFamilyBatchOverlay(plates)
  const [heldOverlay, setHeldOverlay] = useState<typeof latestOverlay | null>(null)
  const overlaid = heldOverlay ?? latestOverlay
  const baselineFamilies = useMemo(() => groupFamilies(overlaid), [overlaid])
  const attachedIds = useMemo(() => attachedFamilyIds(overlaid, baselineFamilies), [overlaid, baselineFamilies])
  const counts = useMemo(() => filterCounts(overlaid, attachedIds), [overlaid, attachedIds])
  const workspace = useWorkspaceBatch()
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
  const standardIds = useMemo(() => new Set(show === 'standardPlate' ? plateIdsForCheck(overlaid, show, '', attachedIds) : []), [overlaid, show, attachedIds])
  const matches = (plate: PlateCardData) =>
    matchesPlate(plate, show, query, changedIds, standardIds, attachedIds)
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
  const bulkEdits = useEditPlate({ parallel: true })
  const ordering = useReorderState()
  const standardConfirmation = useStandardConfirmation()
  const standardRepairs = useMemo(() => {
    if (show !== 'standardPlate') return []
    const states = new Set(overlaid.filter(plate => standardIds.has(plate.id)).map(plate => plate.state))
    return [...states].filter(state => ordering.stateOrders?.[state]).flatMap(state => {
      const first = baselineFamilies.find(family => family.template.state === state && !family.template.deleted && family.template.templateRole === 'template')?.template
      return first ? [first] : []
    })
  }, [show, overlaid, standardIds, baselineFamilies, ordering.stateOrders])
  const [issue, setIssue] = useState<Issue | null>(null)
  const [resolving, setResolving] = useState(false)
  const [resolutionError, setResolutionError] = useState('')
  const { mutate } = useSWRConfig()
  const canEdit = workspace.mode === 'selected' ? workspace.status === 'ready' : me.data?.role === 'editor' || me.data?.role === 'owner'
  const drag = usePlateDrag({
    bulkEdits,
    families: baselineFamilies, canEdit: canEdit && !issue && !standardConfirmation.pending, show, query, ordering,
    edits: { ...edits, edit: async (plate, fields, reviewed) => {
      const result = await edits.edit(plate, fields, reviewed)
      if (!result.ok && result.error === 'stale_plate') setIssue({ plate, fields, result })
      return result
    } },
    holdOverlay: held => setHeldOverlay(held ? overlaid : null),
    targets: () => collectDragTargets(container.current, baselineFamilies),
    closePreview: close,
    reload: () => mutate(key => typeof key === 'string' && key.startsWith('/api/batches')),
  })
  async function undoDelete(plate: PlateCardData) {
    setResolutionError('')
    try {
      const result = await edits.edit(plate, { deleted: false })
      if (!result.ok) setIssue({ plate, fields: { deleted: false }, result })
    } catch {
      setResolutionError('Could not undo deletion. Check your connection and try again.')
    }
  }
  async function resolveConflict(reapply: boolean) {
    if (!issue || issue.result.error !== 'stale_plate' || resolving || edits.pending) return
    setResolving(true)
    setResolutionError('')
    try {
      if (reapply) {
        const { currentRevision, batchId, draft } = issue.result
        if (!currentRevision) throw new Error('Missing conflict revision')
        const result = await edits.edit(issue.plate, draft, { batchId, baseRevision: currentRevision, ...(issue.standard ? { standard: issue.standard } : {}) })
        setIssue(result.ok ? null : { ...issue, result })
      } else {
        await mutate(`/api/batches/${issue.result.batchId}`)
        setIssue(null)
      }
    } catch {
      setResolutionError('Could not resolve this move. Check your connection and try again.')
    } finally {
      setResolving(false)
    }
  }
  const families = useMemo(() => {
    if (!drag.optimisticOrder && !drag.optimisticEdit && !drag.optimisticEdits.size) return baselineFamilies
    const positions = new Map(drag.optimisticOrder?.map((id, index) => [id, index]))
    return groupFamilies(overlaid.map(plate => ({
      ...plate,
      ...drag.optimisticEdits.get(plate.id),
      ...(drag.optimisticEdit?.plateId === plate.id ? drag.optimisticEdit.fields : {}),
      sortOrder: positions.get(plate.id) ?? plate.sortOrder,
    })))
  }, [baselineFamilies, overlaid, drag.optimisticOrder, drag.optimisticEdit, drag.optimisticEdits])
  const displayedFamilies = drag.reflow?.families ?? families
  const visible = displayedFamilies
    .map((family, index) => ({ ...family, number: index + 1 }))
    .filter((family) => [family.template, ...family.variants].some(matches))
  useEffect(() => {
    plateSelection.register(overlaid)
    plateSelection.visible(visible.flatMap(family => [family.template, ...family.variants]).filter(matches))
  })
  useLayoutEffect(() => {
    const resize = () => {
      const bounds = container.current?.getBoundingClientRect()
      if (!bounds) return
      setLayout({
        columns: familyColumns(bounds.width),
        ready: true,
        margin: bounds.top + window.scrollY,
      })
    }
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
    const dismissPointer = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('[role=tooltip]')
      )
        close()
    }
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
          estimatedFamilyHeight(family.variants.length),
        ),
      ) + 16,
    overscan: 1,
    scrollMargin: layout.margin,
    scrollPaddingStart: typeof document === 'undefined' ? 0 :
      Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 0,
    getItemKey: (index) => index,
  })
  const virtualRows = virtualizer.getVirtualItems()
  const reflowIdentity = visible.map(family => [family.template.id, ...family.variants.map(plate => plate.id)].join(':')).join('|') + virtualRows.map(row => `${row.index}:${row.start}`).join('|')
  useLayoutEffect(() => {
    container.current?.querySelectorAll<HTMLElement>('[data-drag-row]').forEach(element => virtualizer.measureElement(element))
  }, [displayedFamilies, virtualizer])
  useDragFlip(container, reflowIdentity, !!drag.active)
  useSelectionKeyboard({ close, promote: drag.promote, disabled: !canEdit || drag.saving || edits.pending || bulkEdits.pending, dragging: !!drag.active })
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
    <section aria-label="Plate families" id="families" className="grid grid-cols-[minmax(0,1fr)] gap-[var(--stack-gap)] pb-56 sm:pb-32">
      {code ? <FilterBar counts={counts} code={code} resolveGroup={key => plateIdsForCheck(overlaid, key, query, attachedIds)} onSelectGroup={(key, ids) => {
        const selectedIds = new Set(ids)
        plateSelection.add(overlaid.filter(plate => selectedIds.has(plate.id)))
        onSelectGroup?.(key, ids)
      }} /> : null}
      {standardRepairs.map(first => <Button key={first.state} variant="outline" disabled={!canEdit || edits.pending || standardConfirmation.pending} onClick={async () => {
        const standard = await standardConfirmation.confirm(overlaid.filter(plate => plate.state === first.state), first.id)
        if (standard === false) return
        const fields = { isStandard: true }
        try {
          const result = await edits.edit(first, fields, undefined, standard)
          if (!result.ok) setIssue({ plate: first, fields, result, standard })
        } catch { setResolutionError('Could not save the Standard. Try again.') }
      }}>Make {first.displayName} the Standard</Button>)}
      {standardConfirmation.dialog}
      <SelectionPresence />
      <SelectionBar />
      {issue ? <Conflict issue={issue} pending={resolving || edits.pending} onTheirs={() => void resolveConflict(false)} onMine={() => void resolveConflict(true)} /> : null}
      {resolutionError ? <p role="alert">{resolutionError}</p> : null}
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
                data-drag-row
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
                    onUndoDelete={plate => void undoDelete(plate)}
                    undoPending={edits.pending || resolving || !!issue || drag.saving || !!drag.active}
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
      {drag.standardDialog}
      <p className="sr-only" aria-live="assertive" aria-atomic="true">{drag.announcement}</p>
      {drag.announcement && !drag.active ? <p className="caption py-2" role="status">{drag.announcement}</p> : null}
      {drag.active ? <DragPreview {...drag.active} selectionCount={drag.selectionCount} variantCount={drag.active.item.kind === 'family' ? families.find(family => family.template.id === drag.active?.item.plate.id)?.variants.length : undefined} /> : null}
    </section>
  )
}
