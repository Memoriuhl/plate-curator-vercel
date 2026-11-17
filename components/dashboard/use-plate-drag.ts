'use client'

import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { EditResult, useEditPlate, useReorderState } from '@/lib/client/hooks'
import type { EditableFields } from '@/lib/review/types'
import { familyOrder, newFamilySlug, orderForDrop, pastDragThreshold, scrollVelocity, targetAt, type DragFamily, type DragItem, type DropTarget, type TargetRect } from './drop-targets'
import { reflowForDrop, sameDropTarget } from './drag-reflow'
import { dragElement, measureDragGeometry, type DragGeometry } from './drag-geometry'
import { createStableDragTargets } from './drag-target-elements'
import { scrollDragList } from './drag-list-scroll'

type Options = {
  families: DragFamily[]
  canEdit: boolean
  show: string
  query: string
  edits: ReturnType<typeof useEditPlate>
  ordering: ReturnType<typeof useReorderState>
  targets(): TargetRect[]
  holdOverlay?(held: boolean): void
  closePreview(): void
  reload(): Promise<unknown>
}
type Active = { item: DragItem; target: DropTarget | null; x: number; y: number; keyboard: boolean; geometry: DragGeometry }
const errors = {
  forbidden: "Only the batch's creator or an Owner can edit it.",
  superseded_revision: 'This batch has a newer revision. Reload and try again.',
  invalid_state: 'This batch is no longer open for editing.',
  not_found: 'This plate or batch could not be found.',
  stale_plate: 'Someone changed this while you were editing.',
}

export function usePlateDrag(options: Options) {
  const [active, setActive] = useState<Active | null>(null)
  const [announcement, announce] = useState('')
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null)
  const [optimisticEdit, setOptimisticEdit] = useState<{ plateId: string; fields: EditableFields } | null>(null)
  const [saving, setSaving] = useState(false)
  const latest = useRef(options)
  const current = useRef(active)
  const pressed = useRef<{ item: DragItem; x: number; y: number; geometry: DragGeometry; pointerId: number; timer: ReturnType<typeof setTimeout> | null } | null>(null)
  const suppress = useRef(false)
  const stableTargets = useRef(createStableDragTargets())
  useEffect(() => { latest.current = options })
  const enabled = options.canEdit && options.show === 'all' && !options.query && !options.edits.pending && !options.ordering.pending && !saving

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
    latest.current.holdOverlay?.(true)
    latest.current.closePreview()
    suppress.current = true
    const families = latest.current.families
    const index = families.findIndex(family => family.template.id === item.plate.id || family.variants.some(plate => plate.id === item.plate.id))
    const source = families[index]
    const variantIndex = source?.variants.findIndex(plate => plate.id === item.plate.id) ?? 0
    const rect = keyboard ? dragElement(item)?.getBoundingClientRect() : undefined
    if (rect) { x = rect.left + rect.width / 2; y = rect.top + 24 }
    const geometry = pressed.current?.geometry ?? measureDragGeometry(item, x, y)
    stableTargets.current = createStableDragTargets()
    stableTargets.current(latest.current.targets(), window.scrollX, window.scrollY)
    update({ item, x, y, geometry, keyboard, target: item.kind === 'variant' && source ? { kind: 'variant-slot', familyId: source.template.id, index: variantIndex } : { kind: 'family-slot', index } })
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
    return targetAt(x, y, stable.filter(({ target }) => target.kind !== 'variant-slot' || (item.kind === 'variant' && target.familyId === source?.template.id)))
  }
  async function drop() {
    const drag = current.current
    finish()
    if (!drag?.target) { latest.current.holdOverlay?.(false); announce('Cancelled'); return }
    const { item, target } = drag
    const { families, edits, ordering, reload } = latest.current
    const source = families.find(family => family.template.id === item.plate.id || family.variants.some(plate => plate.id === item.plate.id))
    const destination = target.kind === 'merge' ? families.find(family => family.template.id === target.familyId) : undefined
    if (!source || (target.kind === 'merge' && ((item.kind === 'family' && source.variants.length > 0) || !destination || destination === source))) { latest.current.holdOverlay?.(false); announce('Cancelled'); return }
    setSaving(true)
    const order = reflowForDrop(families, item, target)?.order ?? orderForDrop(families, item, target)
    if (order) setOptimisticOrder(order)
    try {
      let result: EditResult
      if (destination) {
        const fields: EditableFields = { templateRole: 'variant', variantOfPlateId: destination.template.id, templateFamily: destination.template.templateFamily ?? destination.template.id }
        setOptimisticEdit({ plateId: item.plate.id, fields })
        result = await edits.edit(item.plate, fields)
      } else {
        const promote = item.kind === 'variant' && target.kind === 'family-slot'
        if (!order || (!promote && order.every((id, index) => id === familyOrder(families)[index]))) { announce('Dropped'); return }
        if (promote) {
          const fields: EditableFields = { templateRole: 'template', variantOfPlateId: null, templateFamily: newFamilySlug(item.plate, families) }
          setOptimisticEdit({ plateId: item.plate.id, fields })
          result = await edits.edit(item.plate, fields)
          if (!result.ok) {
            announce(errors[result.error])
            if (result.error === 'superseded_revision') await reload()
            return
          }
        }
        result = await ordering.reorder(item.plate.state, order)
      }
      if (!result.ok) {
        announce(errors[result.error])
        if (result.error === 'superseded_revision') await reload()
      } else announce('Dropped')
    } catch {
      announce('Could not save this move. Try again.')
      await reload()
    } finally {
      setOptimisticOrder(null)
      setOptimisticEdit(null)
      setSaving(false)
      latest.current.holdOverlay?.(false)
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
    }
    function abort() { if (current.current) actions.current.cancel(); else actions.current.clearPress() }
    function key(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented || !current.current) return
      if (current.current.keyboard) actions.current.onKeyDown(current.current.item, event)
      else if (event.key === 'Escape') { event.preventDefault(); actions.current.cancel() }
    }
    function preventNative(event: Event) { if (current.current && !current.current.keyboard) event.preventDefault() }
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
    if (!enabled || event.button !== 0) return
    suppress.current = false
    clearPress()
    pressed.current = { item, x: event.clientX, y: event.clientY, geometry: measureDragGeometry(item, event.clientX, event.clientY, event.currentTarget), pointerId: event.pointerId, timer: null }
    if (event.pointerType === 'touch') pressed.current.timer = setTimeout(() => lift(item, event.clientX, event.clientY, false), 400)
  }
  function onKeyDown(item: DragItem, event: { key: string; preventDefault(): void }) {
    if (!enabled) return
    if (event.key === ' ') {
      event.preventDefault()
      if (current.current) void drop()
      else { suppress.current = false; lift(item, 0, 0, true) }
    } else if (event.key === 'Escape' && current.current) { event.preventDefault(); cancel() }
    else if (current.current?.keyboard && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault()
      const drag = current.current
      const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight'
      const family = options.families.find(entry => entry.variants.some(plate => plate.id === item.plate.id))
      const within = item.kind === 'variant' && family
      const previous = drag.target?.kind === 'variant-slot' || drag.target?.kind === 'family-slot' ? drag.target.index : 0
      const sourceIndex = within ? family.variants.findIndex(plate => plate.id === item.plate.id) : options.families.findIndex(entry => entry.template.id === item.plate.id)
      let next = previous + (forward ? 1 : -1)
      if (forward && next === sourceIndex + 1) next++
      if (!forward && next === sourceIndex + 1) next--
      const index = Math.max(0, Math.min(within ? family.variants.length : options.families.length, next))
      update({ ...drag, target: within ? { kind: 'variant-slot', familyId: family.template.id, index } : { kind: 'family-slot', index } })
      announce(`Moved to position ${index > sourceIndex ? index : index + 1}`)
    }
  }
  const canMerge = active?.item.kind === 'variant' || options.families.find(family => family.template.id === active?.item.plate.id)?.variants.length === 0
  const item = active?.item
  const target = active?.target
  const reflow = useMemo(() => item ? reflowForDrop(options.families, item, target ?? null) : null, [options.families, item, target])
  return { active, reflow, announcement, optimisticOrder, optimisticEdit, saving, enabled, canMerge, onPointerDown, onKeyDown, cancel,
    suppressClick(event: { preventDefault(): void; stopPropagation(): void }) { if (suppress.current) { event.preventDefault(); event.stopPropagation(); suppress.current = false } },
    handleTitle: options.show !== 'all' || options.query ? 'Clear filters to reorder' : 'Drag or press Space to reorder',
  }
}
