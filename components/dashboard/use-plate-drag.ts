'use client'

import { useStandardConfirmation } from '@/components/plate/standard-confirmation'
import { groupFamilies } from './family-data'
import { plateSelection } from './plate-selection'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from 'react'
import type {
  EditResult,
  MoveOrigin,
  useEditPlate,
  useReorderState,
} from '@/lib/client/hooks'
import type { EditableFields, StandardChange } from '@/lib/review/types'
import {
  planFamilyMerge,
  type FamilyMergeResult,
} from '@/lib/review/family-merge-plan'
import {
  familyOrder,
  nearestFamilySlot,
  promotionOrder,
  newFamilySlug,
  orderForDrop,
  pastDragThreshold,
  scrollVelocity,
  targetAt,
  type DragFamily,
  type DragItem,
  type DropTarget,
  type TargetRect,
} from './drop-targets'
import { reflowForDrop, sameDropTarget } from './drag-reflow'
import {
  dragElement,
  measureDragGeometry,
  type DragGeometry,
} from './drag-geometry'
import { createStableDragTargets } from './drag-target-elements'
import { scrollDragList } from './drag-list-scroll'

type Options = {
  families: DragFamily[]
  canEdit: boolean
  show: string
  query: string
  catalogVersion?: number
  bulkEdits?: ReturnType<typeof useEditPlate>
  edits: ReturnType<typeof useEditPlate>
  ordering: Pick<ReturnType<typeof useReorderState>, 'reorder' | 'pending'> &
    Partial<
      Pick<
        ReturnType<typeof useReorderState>,
        'capture' | 'move' | 'merge' | 'stateOrders'
      >
    >
  orderBaseline?(state: string):
    | {
        first: string
        plates: Parameters<
          ReturnType<typeof useStandardConfirmation>['confirm']
        >[0]
      }
    | undefined
  targets(): TargetRect[]
  holdOverlay?(held: boolean): void
  closePreview(): void
  reload(): Promise<unknown>
}
type Active = {
  selection: readonly PlateCardData[]
  item: DragItem
  target: DropTarget | null
  x: number
  y: number
  keyboard: boolean
  geometry: DragGeometry
  origin?: MoveOrigin
}
const errors = {
  standard_change_unconfirmed:
    'The Standard changed. Reload and confirm the new Standard again.',
  standard_required: 'Choose another Standard before changing this plate.',
  standard_invalid_template:
    'The first plate must be a Template that is not deleted.',
  forbidden: "Only the batch's creator or an Owner can edit it.",
  superseded_revision: 'This batch has a newer revision. Reload and try again.',
  invalid_state:
    'The Batch rejected this move. Check the current family and order before trying again.',
  not_found: 'This plate or batch could not be found.',
  stale_plate: 'Someone changed this while you were editing.',
}

/**
 * Coordinate pointer and keyboard reordering, family changes and optimistic draft
 * feedback.
 */
export function usePlateDrag(options: Options) {
  const standardConfirmation = useStandardConfirmation()
  const [active, setActive] = useState<Active | null>(null)
  const [announcement, announce] = useState('')
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null)
  const [optimisticEdit, setOptimisticEdit] = useState<{
    plateId: string
    fields: EditableFields
  } | null>(null)
  const [optimisticEdits, setOptimisticEdits] = useState<
    Map<string, EditableFields>
  >(new Map())
  const [saving, setSaving] = useState(false)
  const latest = useRef(options)
  const current = useRef(active)
  // A pointer release can only apply a target the grid has already rendered.
  const displayedTarget = useRef<DropTarget | null>(null)
  const dwell = useRef<{
    target: DropTarget
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  useLayoutEffect(() => {
    displayedTarget.current = active?.target ?? null
  }, [active?.target])
  const pressed = useRef<{
    selection: readonly PlateCardData[]
    origin?: MoveOrigin
    item: DragItem
    x: number
    y: number
    geometry: DragGeometry
    pointerId: number
    timer: ReturnType<typeof setTimeout> | null
  } | null>(null)
  const suppress = useRef(false)
  const stableTargets = useRef(createStableDragTargets())
  const focusRoot = useRef<HTMLElement | null>(null)
  useEffect(() => {
    latest.current = options
  })
  const enabled =
    options.canEdit &&
    options.show === 'all' &&
    !options.query &&
    !options.edits.pending &&
    !options.ordering.pending &&
    !saving &&
    !standardConfirmation.pending
  // Reuse the deleted-family index for drop checks until the family data changes.
  const deletedFamilyIds = useMemo(
    () =>
      new Set(
        options.families
          .filter((family) => family.template.deleted)
          .map((family) => family.template.id)
      ),
    [options.families]
  )

  /** Keep the rendered drag state synchronized with the current pointer and target. */
  function update(value: Active | null) {
    if (
      value &&
      current.current &&
      sameDropTarget(value.target, current.current.target)
    )
      value.target = current.current.target
    current.current = value
    setActive(value)
  }
  /** Clear the pending press timer when a drag starts, ends or is interrupted. */
  function clearPress() {
    if (pressed.current?.timer) clearTimeout(pressed.current.timer)
    pressed.current = null
  }
  /** Clear the pending pointer destination when the drag leaves it or ends. */
  function clearDwell() {
    if (dwell.current) clearTimeout(dwell.current.timer)
    dwell.current = null
  }
  /**
   * Lift the selected item, freeze its source layout and announce its keyboard position.
   */
  function lift(item: DragItem, x: number, y: number, keyboard: boolean) {
    if (item.plate.deleted) return
    focusRoot.current = dragElement(item)?.closest('section') ?? null
    latest.current.holdOverlay?.(true)
    latest.current.closePreview()
    suppress.current = !keyboard
    const families = latest.current.families
    const index = families.findIndex(
      (family) =>
        family.template.id === item.plate.id ||
        family.variants.some((plate) => plate.id === item.plate.id)
    )
    const source = families[index]
    const variantIndex =
      source?.variants.findIndex((plate) => plate.id === item.plate.id) ?? 0
    const rect = keyboard
      ? dragElement(item)?.getBoundingClientRect()
      : undefined
    if (rect) {
      x = rect.left + rect.width / 2
      y = rect.top + 24
    }
    const geometry =
      pressed.current?.geometry ?? measureDragGeometry(item, x, y)
    stableTargets.current = createStableDragTargets()
    stableTargets.current(
      latest.current.targets(),
      window.scrollX,
      window.scrollY
    )
    update({
      selection: pressed.current?.selection ?? selectedFor(item),
      item,
      x,
      y,
      geometry,
      keyboard,
      origin: pressed.current
        ? pressed.current.origin
        : latest.current.ordering.capture?.(),
      target: !keyboard
        ? null
        : item.kind === 'variant' && source
          ? {
              kind: 'variant-slot',
              familyId: source.template.id,
              index: variantIndex,
            }
          : { kind: 'family-slot', index },
    })
    document.body.classList.add('plate-dragging')
    announce(
      `Lifted ${item.plate.displayName} ${item.kind}, position ${index + 1} of ${families.length}`
    )
  }
  /** End the active drag and clear temporary pointer and document state. */
  function finish() {
    clearPress()
    clearDwell()
    displayedTarget.current = null
    update(null)
    document.body.classList.remove('plate-dragging')
  }
  /** Cancel the drag, release the overlay and announce that no drop was made. */
  function cancel() {
    finish()
    latest.current.holdOverlay?.(false)
    announce('Cancelled')
  }
  /**
   * Hit-test the current pointer against valid targets while excluding the original
   * placement.
   */
  function pointerTarget(item: DragItem, x: number, y: number): DropTarget {
    const { families, targets } = latest.current
    const source = families.find((family) =>
      family.variants.some((plate) => plate.id === item.plate.id)
    )
    const stable = stableTargets.current(
      targets(),
      window.scrollX,
      window.scrollY
    )
    const hit = targetAt(
      x,
      y,
      stable.filter(
        ({ target }) =>
          (target.kind !== 'variant-slot' ||
            !deletedFamilyIds.has(target.familyId)) &&
          (target.kind !== 'variant-slot' ||
            (item.kind === 'variant' &&
              target.familyId === source?.template.id))
      )
    )
    return (
      hit ?? {
        kind: 'family-slot',
        index: nearestFamilySlot(x, y, stable, families.length),
        background: true,
      }
    )
  }
  /** Move the lifted card immediately and accept a new destination after its dwell. */
  function trackPointer(x: number, y: number) {
    const drag = current.current
    if (!drag || drag.keyboard) return
    if (drag.x !== x || drag.y !== y) update({ ...drag, x, y })
    const target = pointerTarget(drag.item, x, y)
    if (sameDropTarget(target, dwell.current?.target ?? null)) return
    clearDwell()
    if (sameDropTarget(target, drag.target)) return
    dwell.current = {
      target,
      timer: setTimeout(
        () => {
          const active = current.current
          if (active) update({ ...active, target })
        },
        target.kind === 'merge' ? 450 : 250
      ),
    }
  }
  /**
   * Resolve affected families across the selected plates' loaded states for a bulk edit.
   */
  function actionFamilies(plates: readonly PlateCardData[]) {
    const currentStates = new Set(
      latest.current.families.map((family) => family.template.state)
    )
    return [
      ...latest.current.families,
      ...[...new Set(plates.map((plate) => plate.state))]
        .filter((state) => !currentStates.has(state))
        .flatMap((state) => groupFamilies(plateSelection.statePlates(state))),
    ]
  }
  function confirmOrder(
    state: string,
    previousFirst: string | undefined,
    first: string,
    plates: readonly PlateCardData[]
  ) {
    const baseline = latest.current.orderBaseline?.(state)
    if (baseline && baseline.first !== first)
      return standardConfirmation.confirm(baseline.plates, first)
    if (previousFirst !== first)
      return standardConfirmation.confirm(plates, first)
  }

  /**
   * Promote or move selected plates while coordinating standard confirmation and
   * optimistic layout.
   */
  async function editSelection(
    plates: readonly PlateCardData[],
    placement?: { index: number; origin?: MoveOrigin }
  ) {
    const { reload, ordering } = latest.current
    const edits = latest.current.bulkEdits ?? latest.current.edits
    if (!latest.current.canEdit || current.current || saving) return
    let families = actionFamilies(plates)
    const initialFamilies = families
    const moving = plates.filter(
      (plate) => !plate.deleted && plate.templateRole === 'variant'
    )
    if (!moving.length) {
      latest.current.holdOverlay?.(false)
      announce('No Variants selected')
      return
    }
    latest.current.closePreview()
    latest.current.holdOverlay?.(true)
    const previousOrders = new Map(
      [...new Set(moving.map((plate) => plate.state))].map((state) => [
        state,
        familyOrder(
          families.filter((family) => family.template.state === state)
        ),
      ])
    )
    const planned = new Map<string, EditableFields>()
    for (const plate of moving) {
      const fields: EditableFields = {
        templateRole: 'template',
        variantOfPlateId: null,
        templateFamily: newFamilySlug(plate, families),
      }
      planned.set(plate.id, fields)
      families = groupFamilies(
        families
          .flatMap((family) => [family.template, ...family.variants])
          .map((candidate) =>
            candidate.id === plate.id ? { ...candidate, ...fields } : candidate
          )
      )
    }
    const orders = new Map(
      [...previousOrders.keys()].map((state) => [
        state,
        promotionOrder(
          initialFamilies.filter((family) => family.template.state === state),
          moving
            .filter((plate) => plate.state === state)
            .map((plate) => plate.id),
          state === latest.current.families[0]?.template.state
            ? placement?.index
            : undefined
        ),
      ])
    )
    const acknowledgements = new Map<string, StandardChange | undefined>()
    for (const [state, order] of orders) {
      const statePlates = initialFamilies
        .filter((family) => family.template.state === state)
        .flatMap((family) => [family.template, ...family.variants])
      const confirmation = confirmOrder(
        state,
        previousOrders.get(state)?.[0],
        order[0],
        statePlates
      )
      const standard = confirmation ? await confirmation : undefined
      if (standard === false) {
        latest.current.holdOverlay?.(false)
        announce('Cancelled')
        return
      }
      acknowledgements.set(state, standard)
    }
    moving.sort(
      (a, b) =>
        Number(orders.get(b.state)?.[0] === b.id) -
        Number(orders.get(a.state)?.[0] === a.id)
    )
    setSaving(true)
    setOptimisticOrder([...orders.values()].flat())
    setOptimisticEdits(planned)
    const succeeded: {
      plate: PlateCardData
      result: Extract<EditResult, { ok: true }>
    }[] = []
    let failure: string | undefined
    try {
      if (!ordering.move || !ordering.capture)
        throw new Error('Reload before moving a Variant')
      const states = [...orders.keys()].sort(
        (a, b) =>
          Number(previousOrders.get(a)?.[0] !== orders.get(a)?.[0]) -
          Number(previousOrders.get(b)?.[0] !== orders.get(b)?.[0])
      )
      for (const state of states) {
        const members = moving.filter((plate) => plate.state === state)
        const order = orders.get(state)!
        const origin =
          succeeded.length === 0 && placement?.origin
            ? placement.origin
            : ordering.capture()
        const standard = acknowledgements.get(state)
        const promotions = members.map((plate) => ({
          plateId: plate.id,
          templateFamily: planned.get(plate.id)!.templateFamily!,
        }))
        const proposal = promotions.length === 1 ? promotions[0] : promotions
        const result = standard
          ? await ordering.move(state, order, proposal, origin, standard)
          : await ordering.move(state, order, proposal, origin)
        if (!result.ok) {
          failure =
            ('message' in result && result.message) || errors[result.error]
          break
        }
        succeeded.push(
          ...members.map((plate) => ({
            plate,
            result: {
              ...result,
              revision:
                result.revisions?.[plate.id] ??
                (members.length === 1 ? result.revision : undefined),
            },
          }))
        )
      }
    } catch {
      failure = 'Could not confirm the template move in the saved Batch.'
    }
    try {
      if (failure) {
        let reverted = 0
        let orderRestored = true
        const restoredRevisions: Record<string, string> = {}
        for (const [state, order] of previousOrders) {
          if (!succeeded.some((entry) => entry.plate.state === state)) continue
          try {
            const from = orders.get(state)![0]
            const standard =
              from !== order[0] ? { from, to: order[0] } : undefined
            const result = standard
              ? await ordering.reorder(state, order, standard)
              : await ordering.reorder(state, order)
            if (!result.ok) orderRestored = false
            else Object.assign(restoredRevisions, result.revisions)
          } catch {
            orderRestored = false
          }
        }
        const unreverted = new Set(succeeded.map((entry) => entry.plate.id))
        if (orderRestored)
          for (const { plate, result } of succeeded.toReversed()) {
            try {
              const revision = restoredRevisions[plate.id] ?? result.revision
              if (
                !revision ||
                !result.batchId ||
                plate.templateRole === null ||
                plate.templateFamily === null
              )
                continue
              const fields: EditableFields = {
                templateRole: plate.templateRole,
                templateFamily: plate.templateFamily,
                variantOfPlateId: plate.variantOfPlateId,
              }
              const restored = await edits.edit(
                { ...plate, revision },
                fields,
                { batchId: result.batchId, baseRevision: revision }
              )
              if (restored.ok) {
                reverted++
                unreverted.delete(plate.id)
              }
            } catch {
              continue
            }
          }
        const saved = new Set(succeeded.map((entry) => entry.plate.id))
        plateSelection.replace(
          plates.filter(
            (plate) => !saved.has(plate.id) || unreverted.has(plate.id)
          )
        )
        const message =
          reverted === succeeded.length && orderRestored
            ? 'Saved ' +
              succeeded.length +
              ' of ' +
              moving.length +
              '; changes undone'
            : succeeded.length -
              reverted +
              ' of ' +
              moving.length +
              ' saved' +
              (orderRestored ? '' : '; order could not be restored')
        announce(succeeded.length ? message : failure)
      } else {
        plateSelection.replace([])
        announce(
          moving.length === 1
            ? '1 plate is now a Template'
            : moving.length + ' plates are now Templates'
        )
      }
      await reload()
    } catch {
      announce(
        'Could not check the saved Batch. Refresh before trying this move again.'
      )
    } finally {
      setOptimisticEdits(new Map())
      setOptimisticOrder(null)
      setSaving(false)
      latest.current.holdOverlay?.(false)
    }
  }
  /** Use the existing multi-selection when the lifted plate belongs to it. */
  function selectedFor(item: DragItem) {
    return plateSelection.has(item.plate.id)
      ? plateSelection.snapshot()
      : [item.plate]
  }
  /** Check that the proposed destination is an eligible, non-deleted family template. */
  function validMerge(family: DragFamily) {
    return (
      !family.template.deleted && family.template.templateRole === 'template'
    )
  }

  /** Summarize the moved and skipped plates for the drag result announcement. */
  function mergeAnnouncement(
    { moved, alreadyInFamily, standard, deleted }: FamilyMergeResult,
    skipped: string
  ) {
    return [
      moved.length === 1
        ? '1 plate moved'
        : moved.length
          ? `${moved.length} plates moved`
          : 'No plates moved',
      standard
        ? `Skipped ${standard} selection${standard === 1 ? '' : 's'} protected by the Standard rule`
        : '',
      alreadyInFamily ? `${alreadyInFamily} already in this family` : '',
      deleted ? `${deleted} deleted` : '',
      skipped,
    ]
      .filter(Boolean)
      .join('. ')
  }

  /**
   * Plan and save a family merge while keeping the optimistic grid and selection in
   * sync.
   */
  async function dropIntoFamily(drag: Active, family: DragFamily | undefined) {
    const { families, ordering, reload, holdOverlay, catalogVersion } =
      latest.current
    try {
      if (!family || !validMerge(family)) {
        announce('Drop onto an active Template family.')
        return
      }
      const destination = family.template
      const local = drag.selection.filter(
        (plate) => plate.state === destination.state
      )
      const elsewhere = drag.selection.length - local.length
      const skipped =
        elsewhere === 1
          ? 'Skipped 1 plate from another state'
          : elsewhere
            ? `Skipped ${elsewhere} plates from other states`
            : ''
      const plan = planFamilyMerge(
        families,
        family,
        local.map((plate) => plate.id),
        ordering.stateOrders?.[destination.state]?.[0]
      )
      if (
        !plan.changes.size &&
        plan.result.alreadyInFamily +
          plan.result.standard +
          plan.result.deleted ===
          local.length
      ) {
        announce(
          local.length && plan.result.alreadyInFamily === local.length
            ? ['The selected plates are already in this family', skipped]
                .filter(Boolean)
                .join('. ')
            : mergeAnnouncement(plan.result, skipped)
        )
        return
      }
      if (!ordering.merge || !drag.origin) {
        announce('Reload before moving plates into a family.')
        return
      }
      setSaving(true)
      setOptimisticEdits(plan.changes)
      announce('Saving family move…')
      const result = await ordering.merge(
        {
          destination: { id: destination.id, revision: destination.revision },
          members: local.map(({ id, revision }) => ({ id, revision })),
          catalogVersion,
        },
        drag.origin
      )
      if (result.ok) {
        const movedIds = new Set(result.value.moved)
        if (plateSelection.snapshot().some((plate) => movedIds.has(plate.id))) {
          plateSelection.replace(
            plateSelection.snapshot().filter((plate) => !movedIds.has(plate.id))
          )
        }
        announce(mergeAnnouncement(result.value, skipped))
      } else announce(result.message)
      try {
        await reload()
      } catch {
        announce(
          result.ok
            ? 'Refresh the Batch to see the saved family move.'
            : result.message + ' Refresh the Batch to load current families.'
        )
      }
    } catch {
      announce('Checking the saved Batch after an interrupted move response.')
      try {
        await reload()
        announce(
          'Batch refreshed. Check the family before trying this move again.'
        )
      } catch {
        announce('Refresh the Batch to check whether the move was saved.')
      }
    } finally {
      setOptimisticEdits(new Map())
      setSaving(false)
      holdOverlay?.(false)
    }
  }

  /** Resolve the drop operation and move focus to the affected plate after it settles. */
  async function drop() {
    const drag = current.current
    const target = drag?.keyboard ? drag.target : displayedTarget.current
    finish()
    if (!drag) return
    if (drag.item.plate.deleted) {
      latest.current.holdOverlay?.(false)
      announce('Cancelled')
      return
    }
    const selected = drag.selection
    if (!target) {
      latest.current.holdOverlay?.(false)
      announce('Cancelled')
      return
    }
    const { item } = drag
    const { families, ordering, reload } = latest.current
    const source = families.find(
      (family) =>
        family.template.id === item.plate.id ||
        family.variants.some((plate) => plate.id === item.plate.id)
    )
    if (target.kind === 'merge') {
      await dropIntoFamily(
        drag,
        families.find((family) => family.template.id === target.familyId)
      )
      return
    }
    if (!source || item.plate.deleted) {
      latest.current.holdOverlay?.(false)
      announce('Cancelled')
      return
    }
    if (
      target.kind === 'family-slot' &&
      (target.background || (item.kind === 'variant' && selected.length > 1))
    ) {
      await editSelection(selected, {
        index: target.index,
        origin: drag.origin,
      })
      return
    }
    const order =
      reflowForDrop(families, item, target)?.order ??
      orderForDrop(families, item, target)
    const promote = item.kind === 'variant' && target.kind === 'family-slot'
    if (
      !order ||
      (!promote &&
        order.every((id, index) => id === familyOrder(families)[index]))
    ) {
      latest.current.holdOverlay?.(false)
      announce('Dropped')
      return
    }
    const statePlates = families.flatMap((family) => [
      family.template,
      ...family.variants,
    ])
    const confirmation = confirmOrder(
      item.plate.state,
      familyOrder(families)[0],
      order[0],
      statePlates
    )
    const standard = confirmation ? await confirmation : undefined
    if (standard === false) {
      latest.current.holdOverlay?.(false)
      announce('Cancelled')
      return
    }
    setSaving(true)
    setOptimisticOrder(order)
    try {
      let result: EditResult
      if (promote) {
        const fields: EditableFields = {
          templateRole: 'template',
          variantOfPlateId: null,
          templateFamily: newFamilySlug(item.plate, families),
        }
        setOptimisticEdit({ plateId: item.plate.id, fields })
        if (!ordering.move || !drag.origin)
          throw new Error('Reload before moving a Variant')
        result = standard
          ? await ordering.move(
              item.plate.state,
              order,
              {
                plateId: item.plate.id,
                templateFamily: fields.templateFamily!,
              },
              drag.origin,
              standard
            )
          : await ordering.move(
              item.plate.state,
              order,
              {
                plateId: item.plate.id,
                templateFamily: fields.templateFamily!,
              },
              drag.origin
            )
      } else
        result = standard
          ? await ordering.reorder(item.plate.state, order, standard)
          : await ordering.reorder(item.plate.state, order)
      if (!result.ok) {
        announce(
          ('message' in result && result.message) || errors[result.error]
        )
        if (result.error === 'superseded_revision') {
          setOptimisticOrder(null)
          setOptimisticEdit(null)
          await reload()
          announce(
            result.message ??
              'This Batch changed. Drag again to choose a position in the latest order.'
          )
        }
      } else announce('Dropped')
    } catch {
      announce(
        'The move response was interrupted. Refreshing the saved Batch to check its result.'
      )
      try {
        await reload()
      } catch {
        announce(
          'Could not check the saved Batch. Refresh before trying this move again.'
        )
      }
    } finally {
      setOptimisticOrder(null)
      setOptimisticEdit(null)
      setSaving(false)
      latest.current.holdOverlay?.(false)
      if (drag.keyboard)
        requestAnimationFrame(() => {
          Array.from(
            focusRoot.current?.querySelectorAll<HTMLElement>(
              '[data-drag-handle-id]'
            ) ?? []
          )
            .find((element) => element.dataset.dragHandleId === item.plate.id)
            ?.focus()
        })
    }
  }
  const actions = useRef({
    lift,
    drop,
    cancel,
    clearPress,
    clearDwell,
    onKeyDown,
    trackPointer,
  })
  useEffect(() => {
    actions.current = {
      lift,
      drop,
      cancel,
      clearPress,
      clearDwell,
      onKeyDown,
      trackPointer,
    }
  })
  useEffect(() => {
    /**
     * Lift on sufficient pointer movement and update the active drop target during the
     * drag.
     */
    function move(event: globalThis.PointerEvent) {
      const press = pressed.current
      if (press && press.pointerId !== event.pointerId) return
      if (
        press &&
        !current.current &&
        pastDragThreshold(event.clientX - press.x, event.clientY - press.y)
      ) {
        if (event.pointerType === 'touch') {
          actions.current.clearPress()
          return
        }
        actions.current.lift(press.item, event.clientX, event.clientY, false)
      }
      const drag = current.current
      if (!drag || drag.keyboard) return
      event.preventDefault()
      actions.current.trackPointer(event.clientX, event.clientY)
    }
    /** Finish the pointer drop and absorb the trailing click so it cannot navigate. */
    function up(event: globalThis.PointerEvent) {
      if (pressed.current && pressed.current.pointerId !== event.pointerId)
        return
      actions.current.clearPress()
      const drag = current.current
      if (drag && !drag.keyboard) void actions.current.drop()
      if (suppress.current) {
        /** Suppress the click generated by releasing the completed drag. */
        const swallow = (click: MouseEvent) => {
          click.preventDefault()
          click.stopPropagation()
        }
        /**
         * Remove click suppression after the browser finishes the drag release sequence.
         */
        const release = () =>
          window.removeEventListener('click', swallow, { capture: true })
        window.addEventListener('click', swallow, { capture: true, once: true })
        window.addEventListener('pointerdown', release, {
          capture: true,
          once: true,
        })
        setTimeout(() => {
          suppress.current = false
          release()
          window.removeEventListener('pointerdown', release, { capture: true })
        })
      }
    }
    /** Cancel an active drag on interruption or clear its pending lift. */
    function abort() {
      if (current.current) actions.current.cancel()
      else actions.current.clearPress()
    }
    /** Handle the active drag's global keyboard controls, including Escape. */
    function key(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented || !current.current) return
      if (current.current.keyboard)
        actions.current.onKeyDown(current.current.item, event)
      else if (event.key === 'Escape') {
        event.preventDefault()
        actions.current.cancel()
      }
    }
    /** Recalculate the drop target after scrolling changes the visible geometry. */
    function scrolled() {
      const drag = current.current
      if (!drag || drag.keyboard) return
      actions.current.trackPointer(drag.x, drag.y)
    }
    /** Prevent the browser's native drag while the app is handling a pointer lift. */
    function preventNative(event: Event) {
      if (current.current && !current.current.keyboard) event.preventDefault()
    }
    window.addEventListener('scroll', scrolled, true)
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', abort)
    window.addEventListener('blur', abort)
    window.addEventListener('keydown', key)
    window.addEventListener('touchmove', preventNative, { passive: false })
    window.addEventListener('contextmenu', preventNative)
    return () => {
      actions.current.clearPress()
      actions.current.clearDwell()
      document.body.classList.remove('plate-dragging')
      window.removeEventListener('scroll', scrolled, true)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', abort)
      window.removeEventListener('blur', abort)
      window.removeEventListener('keydown', key)
      window.removeEventListener('touchmove', preventNative)
      window.removeEventListener('contextmenu', preventNative)
    }
  }, [])
  const dragging = active !== null
  useEffect(() => {
    if (!dragging) return
    let frame = 0
    /** Auto-scroll near the drag edges and refresh hit testing as the content moves. */
    function scroll() {
      const drag = current.current
      if (drag && !drag.keyboard) {
        const source =
          drag.item.kind === 'variant' &&
          latest.current.families.find((family) =>
            family.variants.some((plate) => plate.id === drag.item.plate.id)
          )
        const nested =
          source && scrollDragList(drag.x, drag.y, source.template.id)
        const speed = nested ? 0 : scrollVelocity(drag.y, window.innerHeight)
        if (speed || nested) {
          if (speed) window.scrollBy(0, speed)
          actions.current.trackPointer(drag.x, drag.y)
        }
      }
      frame = requestAnimationFrame(scroll)
    }
    frame = requestAnimationFrame(scroll)
    return () => cancelAnimationFrame(frame)
  }, [dragging])
  useEffect(() => {
    if (!enabled && current.current) actions.current.cancel()
  }, [enabled])

  /**
   * Capture the starting revision and arm a lift for an eligible primary pointer press.
   */
  function onPointerDown(item: DragItem, event: PointerEvent<HTMLElement>) {
    suppress.current = false
    if (!enabled || item.plate.deleted || event.button !== 0) return
    clearPress()
    pressed.current = {
      selection: selectedFor(item),
      origin: latest.current.ordering.capture?.(),
      item,
      x: event.clientX,
      y: event.clientY,
      geometry: measureDragGeometry(
        item,
        event.clientX,
        event.clientY,
        event.currentTarget
      ),
      pointerId: event.pointerId,
      timer: null,
    }
    if (event.pointerType === 'touch')
      pressed.current.timer = setTimeout(
        () => lift(item, event.clientX, event.clientY, false),
        400
      )
  }
  /** Lift, move or drop the focused item using the keyboard reorder controls. */
  function onKeyDown(
    item: DragItem,
    event: { key: string; preventDefault(): void }
  ) {
    if (!enabled || item.plate.deleted) return
    if (event.key === ' ') {
      event.preventDefault()
      if (current.current) void drop()
      else lift(item, 0, 0, true)
    } else if (event.key === 'Escape' && current.current) {
      event.preventDefault()
      cancel()
    } else if (
      current.current?.keyboard &&
      ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)
    ) {
      event.preventDefault()
      const drag = current.current
      const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight'
      const family = options.families.find((entry) =>
        entry.variants.some((plate) => plate.id === item.plate.id)
      )
      const within =
        item.kind === 'variant' &&
        family &&
        event.key !== 'ArrowLeft' &&
        event.key !== 'ArrowRight' &&
        drag.target?.kind !== 'family-slot'
      const previous =
        item.kind === 'variant' &&
        family &&
        !within &&
        drag.target?.kind === 'variant-slot'
          ? options.families.indexOf(family)
          : drag.target?.kind === 'variant-slot' ||
              drag.target?.kind === 'family-slot'
            ? drag.target.index
            : 0
      const sourceIndex = within
        ? family.variants.findIndex((plate) => plate.id === item.plate.id)
        : options.families.findIndex(
            (entry) => entry.template.id === item.plate.id
          )
      let next = previous + (forward ? 1 : -1)
      if (forward && next === sourceIndex + 1) next++
      if (!forward && next === sourceIndex + 1) next--
      const index = Math.max(
        0,
        Math.min(
          within ? family.variants.length : options.families.length,
          next
        )
      )
      update({
        ...drag,
        target: within
          ? { kind: 'variant-slot', familyId: family.template.id, index }
          : { kind: 'family-slot', index },
      })
      announce(`Moved to position ${index > sourceIndex ? index : index + 1}`)
    }
  }
  /**
   * Check that the current same-state selection contains a plate eligible to join the
   * target family.
   */
  function canMergeInto(family: DragFamily) {
    const inFamily = new Set([
      family.template.id,
      ...family.variants.map((plate) => plate.id),
    ])
    return (
      validMerge(family) &&
      !!active?.selection.some(
        (plate) =>
          !plate.deleted &&
          !plate.isStandard &&
          plate.state === family.template.state &&
          !inFamily.has(plate.id)
      )
    )
  }
  const item = active?.item
  const target = active?.target
  // Background placement still promotes Variants only.
  const previewPlate =
    active &&
    target?.kind === 'family-slot' &&
    target.background &&
    item?.kind === 'family'
      ? active.selection.find(
          (plate) =>
            !plate.deleted &&
            plate.state === item.plate.state &&
            plate.templateRole === 'variant'
        )
      : item?.plate
  const previewKind = previewPlate === item?.plate ? item?.kind : 'variant'
  // Pointer motion within a drop slot can reuse the same reflowed family layout.
  const reflow = useMemo(
    () =>
      previewPlate && previewKind
        ? reflowForDrop(
            options.families,
            { kind: previewKind, plate: previewPlate },
            target ?? null
          )
        : null,
    [options.families, previewPlate, previewKind, target]
  )
  return {
    standardDialog: standardConfirmation.dialog,
    active,
    reflow,
    placeholder:
      reflow?.placeholder ??
      (item && !target ? { id: item.plate.id, kind: item.kind } : undefined),
    announcement,
    optimisticEdits,
    /** Promote the current multi-selection using the shared family edit flow. */ promote:
      () => editSelection(plateSelection.snapshot()),
    selectionCount: active?.selection.length ?? 0,
    optimisticOrder,
    optimisticEdit,
    saving,
    enabled,
    canMergeInto,
    onPointerDown,
    onKeyDown,
    cancel,
    /**
     * Consume the first click after a completed pointer drag to avoid accidental
     * navigation.
     */
    suppressClick(event: { preventDefault(): void; stopPropagation(): void }) {
      if (suppress.current) {
        event.preventDefault()
        event.stopPropagation()
        suppress.current = false
      }
    },
    handleTitle:
      options.show !== 'all' || options.query
        ? 'Clear filters to reorder'
        : 'Drag or press Shift+Space to reorder',
  }
}
