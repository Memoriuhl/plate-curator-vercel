'use client'

import { Button } from '@/components/ui/button'
import { useStandardConfirmation } from '@/components/plate/standard-confirmation'
import {
  plateSelection,
  useSelectionKeyboard,
  SelectionPresence,
} from './plate-selection'
import { SelectionBar } from './selection-bar'
import { selectionActions } from './selection-actions'
import dynamic from 'next/dynamic'
import { FilterBar } from './filter-bar'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { familyColumns } from './grid-feel'
import { useGridEntrance } from './use-grid-entrance'
import { useDragFlip } from './use-drag-flip'
import { estimatedFamilyHeight } from './variant-list-layout'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import {
  useWorkspaceBatch,
  useDraftOverlay,
  useEditPlate,
  useMe,
  useReorderState,
  usePreloadPlateDetail,
} from '@/lib/client/hooks'
import { useSWRConfig } from 'swr'
import { usePlateDrag } from './use-plate-drag'
import { collectDragTargets } from './drag-target-elements'
import { DragPreview } from './drag-preview'
import { StatusToast } from './status-toast'
import { Conflict, type Issue } from '@/components/plate/edit-conflict'
import { FamilyCard } from '@/components/plate/family-card'
import { UserAvatar, userAvatarName } from '@/components/app/user-avatar'
import { useSession } from '@/lib/client/session'
import {
  groupFamilies,
  attachedFamilyIds,
  filterCounts,
  matchesPlate,
  parseShow,
  serializeShow,
  plateIdsForCheck,
  expandFamilyPlate,
  type FamilyPlate,
} from './family-data'

import type { PlateCheckKey } from '@/lib/catalog/dashboard-types'

/** Load the hover card on demand so the grid can render before the preview code is needed. */
const ReadyPlatePreview = dynamic(
  () =>
    import('@/components/plate/ready-plate-preview').then(
      (module) => module.ReadyPlatePreview
    ),
  { loading: () => null }
)

/**
 * Build the catalog baselines used to overlay the current batch's draft plates and
 * order.
 */
export function useFamilyBatchOverlay(plates: FamilyPlate[]) {
  // Keep the expanded baselines stable so the draft overlay can reuse its projection.
  const baselines = useMemo(() => plates.map(expandFamilyPlate), [plates])
  return useDraftOverlay(baselines)
}

/**
 * Render the state family grid with filtering, selection, drag editing and virtualized
 * rows.
 */
export function FamilyGrid({
  plates,
  code,
  catalogVersion,
  onSelectGroup,
}: {
  plates: FamilyPlate[]
  code?: string
  catalogVersion?: number
  onSelectGroup?(key: string, ids: string[]): void
}) {
  const params = useSearchParams()
  const pathname = usePathname()
  const latestOverlay = useFamilyBatchOverlay(plates)
  const [heldOverlay, setHeldOverlay] = useState<typeof latestOverlay | null>(
    null
  )
  const [notice, setNotice] = useState<{ message: string } | null>(null)
  const dismissNotice = useCallback(() => setNotice(null), [])
  const overlaid = heldOverlay ?? latestOverlay
  const baselineFamilies = useMemo(() => groupFamilies(overlaid), [overlaid])
  const attachedIds = useMemo(
    () => attachedFamilyIds(overlaid, baselineFamilies),
    [overlaid, baselineFamilies]
  )
  const counts = useMemo(
    () => filterCounts(overlaid, attachedIds),
    [overlaid, attachedIds]
  )
  const workspace = useWorkspaceBatch()
  // Index changed IDs once per overlay so each filter check can look up a plate directly.
  const changedIds = useMemo(
    () =>
      new Set(
        overlaid
          .filter((plate) => plate.changedInBatch)
          .map((plate) => plate.id)
      ),
    [overlaid]
  )
  const rawShow = params.get('show')
  const show = useMemo(() => serializeShow(parseShow(rawShow)), [rawShow])
  const standardFilter = show.includes('standardPlate')
  const query = params.get('q') ?? ''
  const focusPlateId = params.get('plate')
  // Reuse the state-wide Standard check as search text changes.
  const standardIds = useMemo(
    () =>
      new Set(
        standardFilter
          ? plateIdsForCheck(overlaid, 'standardPlate', '', attachedIds)
          : []
      ),
    [overlaid, standardFilter, attachedIds]
  )
  /**
   * Apply the current search and completeness filters with the precomputed family
   * context.
   */
  const matches = useCallback(
    (plate: PlateCardData) =>
      matchesPlate(plate, show, query, changedIds, standardIds, attachedIds),
    [show, query, changedIds, standardIds, attachedIds]
  )
  const matchingIds = useMemo(
    () => new Set(overlaid.filter(matches).map((plate) => plate.id)),
    [overlaid, matches]
  )
  const filterKey = JSON.stringify([pathname, show, query])
  const [dropVisibility, setDropVisibility] = useState<{
    key: string
    dimmed: ReadonlySet<string>
    before?: string[]
  } | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState({
    columns: 5,
    margin: 420,
    ready: false,
  })
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
  // Share prefetched IDs across virtual rows so a remounted card won't repeat the request.
  const [prefetchedIds] = useState(() => new Set<string>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Cancel a pending hover and dismiss the current plate preview. */
  const close = () => {
    if (timer.current) clearTimeout(timer.current)
    anchor.current = null
    setPreview(null)
  }
  const leavePreview = () => {
    if (!opened.current) {
      close()
      return
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(close, 230)
  }
  const { user } = useSession()
  const me = useMe()
  const edits = useEditPlate()
  const bulkEdits = useEditPlate({ parallel: true })
  const ordering = useReorderState()
  const standardConfirmation = useStandardConfirmation()
  // Reuse candidate repairs until the affected families or saved state order changes.
  const standardRepairs = useMemo(() => {
    if (!standardFilter) return []
    const states = new Set(
      overlaid
        .filter((plate) => standardIds.has(plate.id))
        .map((plate) => plate.state)
    )
    return [...states]
      .filter((state) => ordering.stateOrders?.[state])
      .flatMap((state) => {
        const first = baselineFamilies.find(
          (family) =>
            family.template.state === state &&
            !family.template.deleted &&
            family.template.templateRole === 'template'
        )?.template
        return first ? [first] : []
      })
  }, [
    standardFilter,
    overlaid,
    standardIds,
    baselineFamilies,
    ordering.stateOrders,
  ])
  const [issue, setIssue] = useState<Issue | null>(null)
  const [resolving, setResolving] = useState(false)
  const [resolutionError, setResolutionError] = useState('')
  const { mutate } = useSWRConfig()
  const canEdit =
    workspace.mode === 'selected'
      ? workspace.status === 'ready'
      : me.data?.role === 'editor' || me.data?.role === 'owner'
  const drag = usePlateDrag({
    bulkEdits,
    catalogVersion,
    families: baselineFamilies,
    canEdit:
      canEdit &&
      ordering.ready !== false &&
      !issue &&
      !standardConfirmation.pending,
    show,
    query,
    ordering,
    edits: {
      ...edits,
      edit: async (plate, fields, reviewed) => {
        const result = await edits.edit(plate, fields, reviewed)
        if (!result.ok && result.error === 'stale_plate')
          setIssue({ plate, fields, result })
        return result
      },
    },
    /** Freeze the projected grid while a drag or write is using its current geometry. */
    holdOverlay: (held) => setHeldOverlay(held ? overlaid : null),
    onDropSaved: (state: string) => {
      const before = overlaid
        .filter((plate) => plate.state === state && matchingIds.has(plate.id))
        .map((plate) => plate.id)
      setDropVisibility((previous) => ({
        key: filterKey,
        dimmed: previous?.key === filterKey ? previous.dimmed : new Set(),
        before,
      }))
    },
    /**
     * Collect drop targets from the baseline families so drag hit testing stays
     * anchored.
     */
    targets: () => collectDragTargets(container.current, baselineFamilies),
    closePreview: close,
    /** Reload cached batch data after a remote edit or conflict changes the overlay. */
    reload: () =>
      mutate(
        (key) => typeof key === 'string' && key.startsWith('/api/batches')
      ),
  })
  /** Restore the plate's prior deletion state and surface any failed undo. */
  async function undoDelete(plate: PlateCardData) {
    setResolutionError('')
    try {
      const result = await edits.edit(plate, { deleted: false })
      if (!result.ok) setIssue({ plate, fields: { deleted: false }, result })
    } catch {
      setResolutionError(
        'Could not undo deletion. Check your connection and try again.'
      )
    }
  }
  /**
   * Resolve the displayed edit conflict using the refreshed revision and the curator's
   * choice.
   */
  async function resolveConflict(reapply: boolean) {
    if (
      !issue ||
      issue.result.error !== 'stale_plate' ||
      resolving ||
      edits.pending
    )
      return
    setResolving(true)
    setResolutionError('')
    try {
      if (reapply) {
        const { currentRevision, currentEditVersion, batchId, draft } =
          issue.result
        if (!currentRevision) throw new Error('Missing conflict revision')
        const result = await edits.edit(issue.plate, draft, {
          batchId,
          baseRevision: currentRevision,
          editVersion: currentEditVersion,
          ...(issue.standard ? { standard: issue.standard } : {}),
        })
        setIssue(result.ok ? null : { ...issue, result })
      } else {
        await mutate(`/api/batches/${issue.result.batchId}`)
        setIssue(null)
      }
    } catch {
      setResolutionError(
        'Could not resolve this move. Check your connection and try again.'
      )
    } finally {
      setResolving(false)
    }
  }
  // Reuse the optimistic grouping until the drag order, edits or overlay change.
  const families = useMemo(() => {
    if (!drag.optimisticOrder && !drag.optimisticEdits.size)
      return baselineFamilies
    const positions = new Map(
      drag.optimisticOrder?.map((id, index) => [id, index])
    )
    return groupFamilies(
      overlaid.map((plate) => ({
        ...plate,
        ...drag.optimisticEdits.get(plate.id),
        sortOrder: positions.get(plate.id) ?? plate.sortOrder,
      }))
    )
  }, [baselineFamilies, overlaid, drag.optimisticOrder, drag.optimisticEdits])
  const displayedFamilies = drag.reflow?.families ?? families
  const retained = dropVisibility?.key === filterKey ? dropVisibility : null
  const retainedBefore = new Set(retained?.before)
  // Compare with the saved overlay after the drag releases the previous layout.
  if (dropVisibility && dropVisibility.key !== filterKey) {
    setDropVisibility(null)
  } else if (retained?.before && !heldOverlay && !drag.saving) {
    setDropVisibility({
      key: filterKey,
      dimmed: new Set([
        ...retained.dimmed,
        ...retained.before.filter((id) => !matchingIds.has(id)),
      ]),
    })
  }
  const visible = displayedFamilies
    .map((family, index) => ({ ...family, number: index + 1 }))
    .filter((family) =>
      [family.template, ...family.variants].some(
        (plate) =>
          matches(plate) ||
          retained?.dimmed.has(plate.id) ||
          retainedBefore.has(plate.id) ||
          (drag.saving && matchingIds.has(plate.id))
      )
    )
  useEffect(() => {
    plateSelection.register(overlaid)
    plateSelection.visible(
      visible
        .flatMap((family) => [family.template, ...family.variants])
        .filter(matches)
    )
  })
  useLayoutEffect(() => {
    /**
     * Measure the grid container to update row layout and the virtualizer's scroll
     * origin.
     */
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
    /**
     * Dismiss the hover preview when a pointer lands outside the preview and tooltip
     * surfaces.
     */
    const dismissPointer = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('[role=tooltip], [data-check-tooltip]')
      )
        close()
    }
    /**
     * Reposition an open preview after layout changes or close it if its anchor
     * disappeared.
     */
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
      visible.slice(index * layout.columns, (index + 1) * layout.columns)
  )
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    initialRect: { width: 1440, height: 900 },
    /** Estimate a virtual row's height from its tallest family and the grid gap. */
    estimateSize: (index) =>
      Math.max(
        ...rows[index].map((family) =>
          estimatedFamilyHeight(family.variants.length)
        )
      ) + 16,
    overscan: 1,
    scrollMargin: layout.margin,
    scrollPaddingStart:
      typeof document === 'undefined'
        ? 0
        : Number.parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue(
              '--header-h'
            )
          ) || 0,
    /** Use the row index as the virtual grid's key for its current layout. */
    getItemKey: (index) => index,
  })
  const virtualRows = virtualizer.getVirtualItems()
  const focusIndex = focusPlateId
    ? visible.findIndex(
        (family) =>
          family.template.id === focusPlateId ||
          family.variants.some((plate) => plate.id === focusPlateId)
      )
    : -1
  const focusKey =
    focusIndex >= 0
      ? `${pathname}:${workspace.mode === 'selected' ? workspace.id : ''}:${focusPlateId}`
      : null
  const lastFocus = useRef<string | null>(null)
  const targetRowReady =
    focusIndex >= 0 &&
    virtualRows.some(
      (row) => row.index === Math.floor(focusIndex / layout.columns)
    )
  useEffect(() => {
    if (!focusKey) {
      lastFocus.current = null
      return
    }
    if (!layout.ready || lastFocus.current === focusKey) return
    if (!targetRowReady) {
      virtualizer.scrollToIndex(Math.floor(focusIndex / layout.columns), {
        align: 'start',
      })
      return
    }
    const frame = requestAnimationFrame(() => {
      const row = Array.from(
        container.current?.querySelectorAll<HTMLElement>('[data-plate-row]') ??
          []
      ).find((element) => element.dataset.plateRow === focusPlateId)
      if (!row) return
      row.scrollIntoView({ block: 'center', inline: 'nearest' })
      row.focus({ preventScroll: true })
      lastFocus.current = focusKey
    })
    return () => cancelAnimationFrame(frame)
  }, [
    focusKey,
    focusPlateId,
    focusIndex,
    targetRowReady,
    layout.ready,
    layout.columns,
    virtualizer,
  ])
  const reflowIdentity =
    visible
      .map((family) =>
        [family.template.id, ...family.variants.map((plate) => plate.id)].join(
          ':'
        )
      )
      .join('|') +
    virtualRows.map((row) => `${row.index}:${row.start}`).join('|')
  useLayoutEffect(() => {
    container.current
      ?.querySelectorAll<HTMLElement>('[data-drag-row]')
      .forEach((element) => virtualizer.measureElement(element))
  }, [displayedFamilies, virtualizer])
  useDragFlip(container, reflowIdentity, !!drag.active)
  const selectionDisabled =
    !canEdit || drag.saving || edits.pending || bulkEdits.pending
  useSelectionKeyboard({
    close,
    /** Use the viewport toast for the keyboard action's result. */
    promote: () => drag.promote((message) => setNotice({ message })),
    disabled: selectionDisabled,
    dragging: !!drag.active,
  })
  // Offer the same promote action to the selection bar's Make Templates button.
  const promoteSelection = drag.promote
  useEffect(
    () =>
      selectionActions.register('promote', {
        run: promoteSelection,
        disabled: selectionDisabled,
      }),
    [promoteSelection, selectionDisabled]
  )
  const keyboardSource = useRef<string | null>(null)
  useEffect(() => {
    if (drag.active?.keyboard)
      keyboardSource.current = drag.active.item.plate.id
    if (drag.active || drag.saving || !keyboardSource.current) return
    const id = keyboardSource.current
    keyboardSource.current = null
    const index = visible.findIndex(
      (family) =>
        family.template.id === id ||
        family.variants.some((plate) => plate.id === id)
    )
    if (index >= 0)
      virtualizer.scrollToIndex(Math.floor(index / layout.columns), {
        align: 'auto',
      })
    const frame = requestAnimationFrame(() => {
      Array.from(
        container.current?.querySelectorAll<HTMLElement>(
          '[data-drag-handle-id]'
        ) ?? []
      )
        .find((handle) => handle.dataset.dragHandleId === id)
        ?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [drag.active, drag.saving, visible, virtualizer, layout.columns])
  const keyboardSlot =
    drag.active?.keyboard && drag.active.target?.kind === 'family-slot'
      ? drag.active.target.index
      : null
  useEffect(() => {
    if (keyboardSlot === null) return
    virtualizer.scrollToIndex(
      Math.floor(Math.min(keyboardSlot, visible.length - 1) / layout.columns),
      { align: 'auto' }
    )
  }, [keyboardSlot, virtualizer, visible.length, layout.columns])
  /**
   * Schedule or immediately open a plate preview while idle and preload the detail
   * route.
   */
  function open(
    plate: PlateCardData,
    element: HTMLElement,
    immediate: boolean
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
        family.variants.some((plate) => plate.id === preview.plate.id)
      )?.template.displayName
    : undefined
  return (
    <section
      aria-label="Plate families"
      id="families"
      className="grid grid-cols-[minmax(0,1fr)] gap-[var(--stack-gap)] pb-56 sm:pb-32"
    >
      {code ? (
        <FilterBar
          counts={counts}
          code={code}
          resolveGroup={(key) =>
            plateIdsForCheck(overlaid, key, query, attachedIds)
          }
          onSelectGroup={(key, ids) => {
            const selectedIds = new Set(ids)
            plateSelection.add(
              overlaid.filter((plate) => selectedIds.has(plate.id))
            )
            onSelectGroup?.(key, ids)
          }}
        />
      ) : null}
      {code &&
      process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' &&
      overlaid.some((plate) => !plate.deleted) ? (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={() => plateSelection.selectState(code)}
        >
          Select all plates in this state
        </Button>
      ) : null}
      {standardRepairs.map((first) => (
        <Button
          key={first.state}
          variant="outline"
          disabled={!canEdit || edits.pending || standardConfirmation.pending}
          onClick={async () => {
            const standard = await standardConfirmation.confirm(
              overlaid.filter((plate) => plate.state === first.state),
              first.id
            )
            if (standard === false) return
            const fields = { isStandard: true }
            try {
              const result = await edits.edit(
                first,
                fields,
                undefined,
                standard
              )
              if (!result.ok)
                setIssue({ plate: first, fields, result, standard })
            } catch {
              setResolutionError('Could not save the Standard. Try again.')
            }
          }}
        >
          Make {first.displayName} the Standard
        </Button>
      ))}
      {standardConfirmation.dialog}
      <SelectionPresence />
      <SelectionBar />
      {issue ? (
        <Conflict
          issue={issue}
          pending={resolving || edits.pending}
          onTheirs={() => void resolveConflict(false)}
          onMine={() => void resolveConflict(true)}
        />
      ) : null}
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
                    focusPlateId={focusPlateId ?? undefined}
                    onUndoDelete={(plate) => void undoDelete(plate)}
                    undoPending={
                      edits.pending ||
                      resolving ||
                      !!issue ||
                      drag.saving ||
                      !!drag.active
                    }
                    last={family.number === families.length}
                    matches={matches}
                    prefetchedIds={prefetchedIds}
                    onPreview={open}
                    onPreload={preload}
                    onDismissPreview={close}
                    onLeaveCheck={
                      preview?.checkKey === 'image' ? leavePreview : close
                    }
                    onMarker={(plate, element) => {
                      if (drag.active || drag.saving) return
                      opened.current = false
                      anchor.current = element
                      setPreview({
                        plate,
                        anchor: element,
                        immediate: false,
                        markerName: userAvatarName(user),
                      })
                    }}
                    onCheck={(plate, checkKey, element) => {
                      if (drag.active || drag.saving) return
                      opened.current = false
                      anchor.current = element
                      setPreview({
                        plate,
                        anchor: element,
                        immediate: false,
                        checkKey,
                      })
                    }}
                    onClosePreview={leavePreview}
                    badge={(plate) =>
                      changedIds.has(plate.id) && user ? (
                        <UserAvatar
                          user={user}
                          size="sm"
                          activity="changed"
                          aria-label={
                            userAvatarName(user) + ', edited in your batch'
                          }
                        />
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
            onReady={() => {
              opened.current = true
            }}
            parent={parent}
            onMouseEnter={() => {
              if (timer.current) clearTimeout(timer.current)
            }}
            onMouseLeave={leavePreview}
          />
        ) : null}
      </Suspense>
      {drag.standardDialog}
      <StatusToast notice={notice} onDismiss={dismissNotice} />
      <p className="sr-only" aria-live="assertive" aria-atomic="true">
        {drag.announcement}
      </p>
      {drag.announcement && !drag.active ? (
        <p className="caption py-2" role="status">
          {drag.announcement}
        </p>
      ) : null}
      {drag.active ? (
        <DragPreview
          {...drag.active}
          selectionCount={drag.selectionCount}
          variantCount={
            drag.active.item.kind === 'family'
              ? families.find(
                  (family) => family.template.id === drag.active?.item.plate.id
                )?.variants.length
              : undefined
          }
        />
      ) : null}
    </section>
  )
}
