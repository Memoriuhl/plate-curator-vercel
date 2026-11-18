'use client'

import { useStandardConfirmation } from '@/components/plate/standard-confirmation'
import { groupFamilies } from './family-data'
import { plateSelection } from './plate-selection'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { EditResult, MoveOrigin, useEditPlate, useReorderState } from '@/lib/client/hooks'
import type { EditableFields, StandardChange } from '@/lib/review/types'
import { familyOrder, nearestFamilySlot, promotionOrder, newFamilySlug, orderForDrop, pastDragThreshold, scrollVelocity, targetAt, type DragFamily, type DragItem, type DropTarget, type TargetRect } from './drop-targets'
import { reflowForDrop, sameDropTarget } from './drag-reflow'
import { dragElement, measureDragGeometry, type DragGeometry } from './drag-geometry'
import { createStableDragTargets } from './drag-target-elements'
import { scrollDragList } from './drag-list-scroll'

type Options = {
  families: DragFamily[]
  canEdit: boolean
  show: string
  query: string
  bulkEdits?: ReturnType<typeof useEditPlate>
  edits: ReturnType<typeof useEditPlate>
  ordering: Pick<ReturnType<typeof useReorderState>, 'reorder' | 'pending'> & Partial<Pick<ReturnType<typeof useReorderState>, 'capture' | 'move'>>
  targets(): TargetRect[]
  holdOverlay?(held: boolean): void
  closePreview(): void
  reload(): Promise<unknown>
}
type Active = { selection: readonly PlateCardData[]; item: DragItem; target: DropTarget | null; x: number; y: number; keyboard: boolean; geometry: DragGeometry; origin?: MoveOrigin }
const errors = {
  standard_change_unconfirmed: 'The Standard changed. Reload and confirm the new Standard again.',
  standard_required: 'Choose another Standard before changing this plate.',
  standard_invalid_template: 'The first plate must be a Template that is not deleted.',
  forbidden: "Only the batch's creator or an Owner can edit it.",
  superseded_revision: 'This batch has a newer revision. Reload and try again.',
  invalid_state: 'This batch is no longer open for editing.',
  not_found: 'This plate or batch could not be found.',
  stale_plate: 'Someone changed this while you were editing.',
}

export function usePlateDrag(options: Options) {
  const standardConfirmation = useStandardConfirmation()
  const [active, setActive] = useState<Active | null>(null)
  const [announcement, announce] = useState('')
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null)
  const [optimisticEdit, setOptimisticEdit] = useState<{ plateId: string; fields: EditableFields } | null>(null)
  const [optimisticEdits, setOptimisticEdits] = useState<Map<string, EditableFields>>(new Map())
  const [saving, setSaving] = useState(false)
  const latest = useRef(options)
  const current = useRef(active)
  const pressed = useRef<{ item: DragItem; x: number; y: number; geometry: DragGeometry; pointerId: number; timer: ReturnType<typeof setTimeout> | null } | null>(null)
  const suppress = useRef(false)
  const stableTargets = useRef(createStableDragTargets())
  const focusRoot = useRef<HTMLElement | null>(null)
  useEffect(() => { latest.current = options })
  const enabled = options.canEdit && options.show === 'all' && !options.query && !options.edits.pending && !options.ordering.pending && !saving && !standardConfirmation.pending
  const deletedFamilyIds = useMemo(() => new Set(options.families.filter(family => family.template.deleted).map(family => family.template.id)), [options.families])

  function update(value: Active | null) {
    if (value && current.current && sameDropTarget(value.target, current.current.target)) value.target = current.current.target
    current.current = value
    setActive(value)
  }
  function clearPress() {
    if (pressed.current?.timer) clearTimeout(pressed.current.timer)
    pressed.current = null
  }
  function lift(item: DragItem, x: number, y: number, keyboard: boolean) {
    if (item.plate.deleted) return
    focusRoot.current = dragElement(item)?.closest('section') ?? null
    latest.current.holdOverlay?.(true)
    latest.current.closePreview()
    suppress.current = !keyboard
    const families = latest.current.families
    const index = families.findIndex(family => family.template.id === item.plate.id || family.variants.some(plate => plate.id === item.plate.id))
    const source = families[index]
    const variantIndex = source?.variants.findIndex(plate => plate.id === item.plate.id) ?? 0
    const rect = keyboard ? dragElement(item)?.getBoundingClientRect() : undefined
    if (rect) { x = rect.left + rect.width / 2; y = rect.top + 24 }
    const geometry = pressed.current?.geometry ?? measureDragGeometry(item, x, y)
    stableTargets.current = createStableDragTargets()
    stableTargets.current(latest.current.targets(), window.scrollX, window.scrollY)
    update({ selection: selectedFor(item), item, x, y, geometry, keyboard, origin: latest.current.ordering.capture?.(), target: item.kind === 'variant' && source ? { kind: 'variant-slot', familyId: source.template.id, index: variantIndex } : { kind: 'family-slot', index } })
    document.body.classList.add('plate-dragging')
    announce(`Lifted ${item.plate.displayName} ${item.kind}, position ${index + 1} of ${families.length}`)
  }
  function finish() {
    clearPress()
    update(null)
    document.body.classList.remove('plate-dragging')
  }
  function cancel() {
    finish()
    latest.current.holdOverlay?.(false)
    announce('Cancelled')
  }
  function pointerTarget(item: DragItem, x: number, y: number) {
    const { families, targets } = latest.current
    const source = families.find(family => family.variants.some(plate => plate.id === item.plate.id))
    const stable = stableTargets.current(targets(), window.scrollX, window.scrollY)
    return targetAt(x, y, stable.filter(({ target }) =>
      (target.kind !== 'variant-slot' || !deletedFamilyIds.has(target.familyId))
      && (target.kind !== 'variant-slot' || (item.kind === 'variant' && target.familyId === source?.template.id))))
  }
  function actionFamilies(plates: readonly PlateCardData[]) {
    const currentStates = new Set(latest.current.families.map(family => family.template.state))
    return [...latest.current.families, ...[...new Set(plates.map(plate => plate.state))].filter(state => !currentStates.has(state)).flatMap(state => groupFamilies(plateSelection.statePlates(state)))]
  }
  async function editSelection(plates: readonly PlateCardData[], destination?: PlateCardData, placement?: { index: number; origin?: MoveOrigin }) {
    const { reload, ordering } = latest.current
    const edits = latest.current.bulkEdits ?? latest.current.edits
    if (!latest.current.canEdit || current.current || saving) return
    if (destination?.deleted) { announce('Cancelled'); return }
    let families = actionFamilies(plates)
    const initialFamilies = families
    if (destination) {
      const expanded = plates.flatMap(plate => !plate.deleted && plate.id !== destination.id
        ? [plate, ...(families.find(family => family.template.id === plate.id)?.variants ?? [])]
        : [plate])
      plates = [...new Map(expanded.map(plate => [plate.id, plate])).values()]
    }
    const otherStates = destination ? plates.filter(plate => !plate.deleted && plate.state !== destination.state) : []
    const moving = plates.filter(plate => !plate.deleted && (destination
      ? plate.state === destination.state && plate.id !== destination.id && plate.variantOfPlateId !== destination.id && !families.find(family => family.template.id === destination.id)?.variants.some(variant => variant.id === plate.id)
      : plate.templateRole === 'variant'))
    const skippedMessage = otherStates.length ? 'Skipped ' + otherStates.length + ' plates from other states' : ''
    if (!moving.length) { latest.current.holdOverlay?.(false); announce(skippedMessage || (destination ? 'Dropped' : 'No Variants selected')); return }
    latest.current.closePreview()
    latest.current.holdOverlay?.(true)
    const previousOrders = new Map([...new Set(moving.map(plate => plate.state))].map(state => [state, familyOrder(families.filter(family => family.template.state === state))]))
    const planned = new Map<string, EditableFields>()
    for (const plate of moving) {
      const fields: EditableFields = destination
        ? { templateRole: 'variant', variantOfPlateId: destination.id, templateFamily: destination.templateFamily || destination.id }
        : { templateRole: 'template', variantOfPlateId: null, templateFamily: newFamilySlug(plate, families) }
      planned.set(plate.id, fields)
      if (!destination) families = groupFamilies(families.flatMap(family => [family.template, ...family.variants]).map(candidate => candidate.id === plate.id ? { ...candidate, ...fields } : candidate))
    }
    const orders = new Map([...previousOrders.keys()].map(state => [state, promotionOrder(initialFamilies.filter(family => family.template.state === state), moving.filter(plate => plate.state === state).map(plate => plate.id), state === latest.current.families[0]?.template.state ? placement?.index : undefined)]))
    const acknowledgements = new Map<string, StandardChange | undefined>()
    if (!destination) {
      for (const [state, order] of orders) {
        const statePlates = initialFamilies.filter(family => family.template.state === state).flatMap(family => [family.template, ...family.variants])
        const standard = previousOrders.get(state)?.[0] === order[0] ? undefined : await standardConfirmation.confirm(statePlates, order[0])
        if (standard === false) { latest.current.holdOverlay?.(false); announce('Cancelled'); return }
        acknowledgements.set(state, standard)
      }
      moving.sort((a, b) => Number(orders.get(b.state)?.[0] === b.id) - Number(orders.get(a.state)?.[0] === a.id))
    }
    setSaving(true)
    if (!destination) setOptimisticOrder([...orders.values()].flat())
    setOptimisticEdits(planned)
    const succeeded: { plate: PlateCardData; result: Extract<EditResult, { ok: true }> }[] = []
    let failed = false
    try {
      if (destination) {
        for (let index = 0; index < moving.length; index += 3) {
          const chunk = moving.slice(index, index + 3)
          const results = await Promise.allSettled(chunk.map(plate => edits.edit(plate, planned.get(plate.id)!)))
          results.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value.ok) succeeded.push({ plate: chunk[index], result: result.value })
            else failed = true
          })
          if (failed) break
        }
      } else {
        if (!ordering.move || !ordering.capture) throw new Error('Reload before moving a Variant')
        const states = [...orders.keys()].sort((a, b) => Number(previousOrders.get(a)?.[0] !== orders.get(a)?.[0]) - Number(previousOrders.get(b)?.[0] !== orders.get(b)?.[0]))
        for (const state of states) {
          const members = moving.filter(plate => plate.state === state)
          const order = orders.get(state)!
          const origin = succeeded.length === 0 && placement?.origin ? placement.origin : ordering.capture()
          const standard = acknowledgements.get(state)
          const promotions = members.map(plate => ({ plateId: plate.id, templateFamily: planned.get(plate.id)!.templateFamily! }))
          const proposal = promotions.length === 1 ? promotions[0] : promotions
          const result = standard ? await ordering.move(state, order, proposal, origin, standard) : await ordering.move(state, order, proposal, origin)
          if (!result.ok) { failed = true; break }
          succeeded.push(...members.map(plate => ({ plate, result: { ...result, revision: result.revisions?.[plate.id] ?? (members.length === 1 ? result.revision : undefined) } })))
        }
      }
    } catch { failed = true }
    try {
      if (failed) {
        let reverted = 0
        let orderRestored = true
        const restoredRevisions: Record<string, string> = {}
        if (!destination) {
          for (const [state, order] of previousOrders) {
            if (!succeeded.some(entry => entry.plate.state === state)) continue
            try {
              const from = orders.get(state)![0]
              const standard = from !== order[0] ? { from, to: order[0] } : undefined
              const result = standard ? await ordering.reorder(state, order, standard) : await ordering.reorder(state, order)
              if (!result.ok) orderRestored = false
              else Object.assign(restoredRevisions, result.revisions)
            } catch { orderRestored = false }
          }
        }
        const unreverted = new Set(succeeded.map(entry => entry.plate.id))
        if (orderRestored) for (const { plate, result } of succeeded.toReversed()) {
          try {
            const revision = restoredRevisions[plate.id] ?? result.revision
            if (!revision || !result.batchId || plate.templateRole === null || plate.templateFamily === null) continue
            const fields: EditableFields = { templateRole: plate.templateRole, templateFamily: plate.templateFamily, variantOfPlateId: plate.variantOfPlateId }
            const restored = await edits.edit({ ...plate, revision }, fields, { batchId: result.batchId, baseRevision: revision })
            if (restored.ok) { reverted++; unreverted.delete(plate.id) }
          } catch { continue }
        }
        const saved = new Set(succeeded.map(entry => entry.plate.id))
        plateSelection.replace(plates.filter(plate => !saved.has(plate.id) || unreverted.has(plate.id)))
        const message = reverted === succeeded.length && orderRestored ? 'Saved ' + succeeded.length + ' of ' + moving.length + '; changes undone' : (succeeded.length - reverted) + ' of ' + moving.length + ' saved' + (orderRestored ? '' : '; order could not be restored')
        announce([message, skippedMessage].filter(Boolean).join('. '))
      } else {
        plateSelection.replace(otherStates)
        const message = destination ? moving.length + (moving.length === 1 ? ' plate moved' : ' plates moved') : moving.length === 1 ? '1 plate is now a Template' : moving.length + ' plates are now Templates'
        announce([message, skippedMessage].filter(Boolean).join('. '))
      }
      await reload()
    } catch { announce('Could not check the saved Batch. Refresh before trying this move again.') }
    finally {
      setOptimisticEdits(new Map())
      setOptimisticOrder(null)
      setSaving(false)
      latest.current.holdOverlay?.(false)
    }
  }
  function selectedFor(item: DragItem) {
    return plateSelection.has(item.plate.id) ? plateSelection.snapshot() : [item.plate]
  }
  async function drop() {
    const drag = current.current
    finish()
    if (!drag) return
    if (drag.item.plate.deleted) { latest.current.holdOverlay?.(false); announce('Cancelled'); return }
    const selected = drag.selection
    if (!drag.target) {
      if (!drag.keyboard) await editSelection(selected, undefined, { index: nearestFamilySlot(drag.x, drag.y, stableTargets.current(latest.current.targets(), window.scrollX, window.scrollY), latest.current.families.length), origin: drag.origin })
      latest.current.holdOverlay?.(false)
      return
    }
    const { item, target } = drag
    const { families, edits, ordering, reload } = latest.current
    const source = families.find(family => family.template.id === item.plate.id || family.variants.some(plate => plate.id === item.plate.id))
    const destination = target.kind === 'merge' ? families.find(family => family.template.id === target.familyId) : undefined
    if (!source || item.plate.deleted || destination?.template.deleted) { latest.current.holdOverlay?.(false); announce('Cancelled'); return }
    if (target.kind === 'family-slot' && item.kind === 'variant' && selected.length > 1) { await editSelection(selected, undefined, { index: target.index, origin: drag.origin }); return }
    if (target.kind === 'merge' && (!destination || destination === source)) { latest.current.holdOverlay?.(false); announce('Cancelled'); return }
    if (destination && ((item.kind === 'family' && source.variants.length > 0) || selected.length > 1)) { await editSelection(selected, destination.template); return }
    const order = reflowForDrop(families, item, target)?.order ?? orderForDrop(families, item, target)
    const promote = item.kind === 'variant' && target.kind === 'family-slot'
    if (!destination && (!order || !promote && order.every((id, index) => id === familyOrder(families)[index]))) { latest.current.holdOverlay?.(false); announce('Dropped'); return }
    const statePlates = families.flatMap(family => [family.template, ...family.variants])
    const changesStandard = order && !destination && familyOrder(families)[0] !== order[0]
    const standard = changesStandard ? await standardConfirmation.confirm(statePlates, order[0]) : undefined
    if (standard === false) { latest.current.holdOverlay?.(false); announce('Cancelled'); return }
    setSaving(true)
    if (order) setOptimisticOrder(order)
    try {
      let result: EditResult
      if (destination) {
        const fields: EditableFields = { templateRole: 'variant', variantOfPlateId: destination.template.id, templateFamily: destination.template.templateFamily ?? destination.template.id }
        setOptimisticEdit({ plateId: item.plate.id, fields })
        result = await edits.edit(item.plate, fields)
      } else {
        if (!order || (!promote && order.every((id, index) => id === familyOrder(families)[index]))) { announce('Dropped'); return }
        if (promote) {
          const fields: EditableFields = { templateRole: 'template', variantOfPlateId: null, templateFamily: newFamilySlug(item.plate, families) }
          setOptimisticEdit({ plateId: item.plate.id, fields })
          if (!ordering.move || !drag.origin) throw new Error('Reload before moving a Variant')
          result = standard ? await ordering.move(item.plate.state, order, { plateId: item.plate.id, templateFamily: fields.templateFamily! }, drag.origin, standard) : await ordering.move(item.plate.state, order, { plateId: item.plate.id, templateFamily: fields.templateFamily! }, drag.origin)
        } else result = standard ? await ordering.reorder(item.plate.state, order, standard) : await ordering.reorder(item.plate.state, order)
      }
      if (!result.ok) {
        announce(errors[result.error])
        if (result.error === 'superseded_revision') {
          setOptimisticOrder(null)
          setOptimisticEdit(null)
          await reload()
          announce('This Batch changed. Drag again to choose a position in the latest order.')
        }
      } else announce('Dropped')
    } catch {
      announce('The move response was interrupted. Refreshing the saved Batch to check its result.')
      try { await reload() } catch { announce('Could not check the saved Batch. Refresh before trying this move again.') }
    } finally {
      setOptimisticOrder(null)
      setOptimisticEdit(null)
      setSaving(false)
      latest.current.holdOverlay?.(false)
      if (drag.keyboard) requestAnimationFrame(() => {
        Array.from(focusRoot.current?.querySelectorAll<HTMLElement>('[data-drag-handle-id]') ?? [])
          .find(element => element.dataset.dragHandleId === item.plate.id)?.focus()
      })
    }
  }
  const actions = useRef({ lift, drop, cancel, update, clearPress, onKeyDown, pointerTarget })
  useEffect(() => { actions.current = { lift, drop, cancel, update, clearPress, onKeyDown, pointerTarget } })
  useEffect(() => {
    function move(event: globalThis.PointerEvent) {
      const press = pressed.current
      if (press && press.pointerId !== event.pointerId) return
      if (press && !current.current && pastDragThreshold(event.clientX - press.x, event.clientY - press.y)) {
        if (event.pointerType === 'touch') { actions.current.clearPress(); return }
        actions.current.lift(press.item, event.clientX, event.clientY, false)
      }
      const drag = current.current
      if (!drag || drag.keyboard) return
      event.preventDefault()
      actions.current.update({ ...drag, x: event.clientX, y: event.clientY, target: actions.current.pointerTarget(drag.item, event.clientX, event.clientY) })
    }
    function up(event: globalThis.PointerEvent) {
      if (pressed.current && pressed.current.pointerId !== event.pointerId) return
      actions.current.clearPress()
      if (current.current && !current.current.keyboard) void actions.current.drop()
      if (suppress.current) {
        const swallow = (click: MouseEvent) => { click.preventDefault(); click.stopPropagation() }
        const release = () => window.removeEventListener('click', swallow, { capture: true })
        window.addEventListener('click', swallow, { capture: true, once: true })
        window.addEventListener('pointerdown', release, { capture: true, once: true })
        setTimeout(() => {
          suppress.current = false
          release()
          window.removeEventListener('pointerdown', release, { capture: true })
        })
      }
    }
    function abort() { if (current.current) actions.current.cancel(); else actions.current.clearPress() }
    function key(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented || !current.current) return
      if (current.current.keyboard) actions.current.onKeyDown(current.current.item, event)
      else if (event.key === 'Escape') { event.preventDefault(); actions.current.cancel() }
    }
    function scrolled() {
      const drag = current.current
      if (!drag || drag.keyboard) return
      const target = actions.current.pointerTarget(drag.item, drag.x, drag.y)
      if (!sameDropTarget(target, drag.target)) actions.current.update({ ...drag, target })
    }
    function preventNative(event: Event) { if (current.current && !current.current.keyboard) event.preventDefault() }
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
    function scroll() {
      const drag = current.current
      if (drag && !drag.keyboard) {
        const source = drag.item.kind === 'variant' && latest.current.families.find(family => family.variants.some(plate => plate.id === drag.item.plate.id))
        const nested = source && scrollDragList(drag.x, drag.y, source.template.id)
        const speed = nested ? 0 : scrollVelocity(drag.y, window.innerHeight)
        if (speed || nested) {
          if (speed) window.scrollBy(0, speed)
          const target = actions.current.pointerTarget(drag.item, drag.x, drag.y)
          if (!sameDropTarget(target, drag.target)) actions.current.update({ ...drag, target })
        }
      }
      frame = requestAnimationFrame(scroll)
    }
    frame = requestAnimationFrame(scroll)
    return () => cancelAnimationFrame(frame)
  }, [dragging])
  useEffect(() => { if (!enabled && current.current) actions.current.cancel() }, [enabled])

  function onPointerDown(item: DragItem, event: PointerEvent<HTMLElement>) {
    suppress.current = false
    if (!enabled || item.plate.deleted || event.button !== 0) return
    clearPress()
    pressed.current = { item, x: event.clientX, y: event.clientY, geometry: measureDragGeometry(item, event.clientX, event.clientY, event.currentTarget), pointerId: event.pointerId, timer: null }
    if (event.pointerType === 'touch') pressed.current.timer = setTimeout(() => lift(item, event.clientX, event.clientY, false), 400)
  }
  function onKeyDown(item: DragItem, event: { key: string; preventDefault(): void }) {
    if (!enabled || item.plate.deleted) return
    if (event.key === ' ') {
      event.preventDefault()
      if (current.current) void drop()
      else lift(item, 0, 0, true)
    } else if (event.key === 'Escape' && current.current) { event.preventDefault(); cancel() }
    else if (current.current?.keyboard && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault()
      const drag = current.current
      const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight'
      const family = options.families.find(entry => entry.variants.some(plate => plate.id === item.plate.id))
      const within = item.kind === 'variant' && family && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && drag.target?.kind !== 'family-slot'
      const previous = item.kind === 'variant' && family && !within && drag.target?.kind === 'variant-slot' ? options.families.indexOf(family) : drag.target?.kind === 'variant-slot' || drag.target?.kind === 'family-slot' ? drag.target.index : 0
      const sourceIndex = within ? family.variants.findIndex(plate => plate.id === item.plate.id) : options.families.findIndex(entry => entry.template.id === item.plate.id)
      let next = previous + (forward ? 1 : -1)
      if (forward && next === sourceIndex + 1) next++
      if (!forward && next === sourceIndex + 1) next--
      const index = Math.max(0, Math.min(within ? family.variants.length : options.families.length, next))
      update({ ...drag, target: within ? { kind: 'variant-slot', familyId: family.template.id, index } : { kind: 'family-slot', index } })
      announce(`Moved to position ${index > sourceIndex ? index : index + 1}`)
    }
  }
  const canMerge = !!active
  const item = active?.item
  const target = active?.target
  const reflow = useMemo(() => item ? reflowForDrop(options.families, item, target ?? null) : null, [options.families, item, target])
  return { standardDialog: standardConfirmation.dialog, active, reflow, announcement, optimisticEdits, promote: () => editSelection(plateSelection.snapshot()), selectionCount: active?.selection.length ?? 0, optimisticOrder, optimisticEdit, saving, enabled, canMerge, onPointerDown, onKeyDown, cancel,
    suppressClick(event: { preventDefault(): void; stopPropagation(): void }) { if (suppress.current) { event.preventDefault(); event.stopPropagation(); suppress.current = false } },
    handleTitle: options.show !== 'all' || options.query ? 'Clear filters to reorder' : 'Drag or press Shift+Space to reorder',
  }
}
