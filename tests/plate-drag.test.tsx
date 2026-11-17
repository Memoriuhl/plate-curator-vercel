import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { plateCards } from '../fixtures/plate-cards'
import { plateSelection } from '../components/dashboard/plate-selection'
import { usePlateDrag } from '../components/dashboard/use-plate-drag'
import { FamilyCard } from '../components/plate/family-card'
import { familyOrder, moveBlock, nearestFamilySlot, promotionOrder, newFamilySlug, orderForDrop, pastDragThreshold, targetAt, scrollVelocity } from '../components/dashboard/drop-targets'
import { reflowForDrop, sameDropTarget } from '../components/dashboard/drag-reflow'
import { measureDragPositions, playDragFlip } from '../components/dashboard/use-drag-flip'
import { DragPlaceholder, DragPreview } from '../components/dashboard/drag-preview'
import { collectDragTargets, createStableDragTargets } from '../components/dashboard/drag-target-elements'
import { variantListCap, estimatedFamilyHeight, VARIANT_ROW_HEIGHT, VARIANT_ROW_GAP } from '../components/dashboard/variant-list-layout'
import { VirtualizedVariants } from '../components/plate/virtualized-variants'
import { scrollDragList } from '../components/dashboard/drag-list-scroll'
import { useVirtualizer } from '@tanstack/react-virtual'

vi.mock('@tanstack/react-virtual', async importOriginal => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>()
  return { ...actual, useVirtualizer: vi.fn(actual.useVirtualizer) }
})

const a = { ...plateCards[0], id: 'AK.a', displayName: 'Army', templateRole: 'template' as const }
const v = { ...a, id: 'AK.v', templateRole: 'variant' as const }
const w = { ...v, id: 'AK.w' }
const b = { ...a, id: 'AK.b', displayName: 'Navy' }
const families = [{ template: a, variants: [v, w] }, { template: b, variants: [] }]
const success = { ok: true, proposed: {} }
const { push } = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ prefetch: vi.fn(), push }) }))
vi.mock('next/link', () => ({ default: ({ prefetch, ...props }: Record<string, unknown>) => { void prefetch; return <a {...props} /> } }))
vi.mock('next/image', () => ({ default: () => <span /> }))
afterEach(() => { cleanup(); plateSelection.clear(); push.mockClear() })

test('moves family blocks and variants while retaining the full permutation', () => {
  const order = familyOrder(families)
  expect(orderForDrop(families, { kind: 'family', plate: a }, { kind: 'family-slot', index: 2 })).toEqual(['AK.b', 'AK.a', 'AK.v', 'AK.w'])
  expect(orderForDrop(families, { kind: 'variant', plate: w }, { kind: 'variant-slot', familyId: a.id, index: 0 })).toEqual(['AK.a', 'AK.w', 'AK.v', 'AK.b'])
  for (let index = 0; index <= order.length; index++) expect(moveBlock(order, [a.id, v.id, w.id], index).sort()).toEqual([...order].sort())
})
test('threshold, hit targets and scroll edges', () => {
  expect(pastDragThreshold(3, 3)).toBe(false)
  expect(pastDragThreshold(3, 4)).toBe(true)
  expect(targetAt(4, 4, [{ target: { kind: 'family-slot', index: 1 }, rect: { left: 0, right: 10, top: 0, bottom: 10 } }])).toEqual({ kind: 'family-slot', index: 1 })
  expect(scrollVelocity(0, 900)).toBeLessThan(0)
  expect(scrollVelocity(899, 900)).toBeGreaterThan(0)
  expect(scrollVelocity(-800, 900)).toBe(-18)
  expect(scrollVelocity(2400, 900)).toBe(18)
  expect(scrollVelocity(450, 900)).toBe(0)
})

function setup({ rows = false, moveSave = vi.fn().mockResolvedValue(success), show = 'all', query = '', canEdit = true, error = false, merge = false, variant = false, singleton = false, deletedSource = false, deletedDestination = false, save = vi.fn().mockResolvedValue(success) } = {}) {
  const edit = save
  const reorder = vi.fn().mockResolvedValue(error ? { ok: false, error: 'superseded_revision' } : success)
  const move = moveSave
  const capture = vi.fn(() => ({ batchId: 'batch', revision: 4 }))
  const reload = vi.fn().mockResolvedValue(undefined)
  const closePreview = vi.fn()
  function Harness() {
    const dragFamilies = families.map(family => ({ ...family, template: family.template.id === b.id ? { ...family.template, deleted: deletedDestination } : family.template }))
    const drag = usePlateDrag({ families: dragFamilies, canEdit, show, query, edits: { edit, pending: false }, ordering: { reorder, move, capture, pending: false }, reload, closePreview,
      targets: () => [{ target: merge ? { kind: 'merge', familyId: singleton ? a.id : b.id } : { kind: 'family-slot', index: 2 }, rect: { left: 0, right: 500, top: 0, bottom: 500 } }],
    })
    const item = { kind: variant ? 'variant' as const : 'family' as const, plate: deletedSource ? { ...(singleton ? b : variant ? v : a), deleted: true } : singleton ? b : variant ? v : a }
    return <>{rows ? <FamilyCard template={a} variants={[v, w]} canEdit={canEdit} drag={drag} /> : null}<button title={drag.handleTitle} onPointerDown={event => drag.onPointerDown(item, event)} onKeyDown={event => drag.onKeyDown(item, event)} onClick={drag.suppressClick}>Handle</button><output aria-live="polite">{drag.announcement}</output><span data-testid="order">{drag.optimisticOrder?.join(',')}</span><span data-testid="gap">{drag.reflow?.order.join(',')}</span></>
  }
  render(<Harness />)
  return { edit, reorder, move, capture, reload, closePreview, handle: rows ? document.querySelector<HTMLElement>('[data-plate-row="' + (variant ? v.id : a.id) + '"]')! : screen.getByRole('button') }
}

test('keyboard lifts, moves, drops once and removes the global cursor', async () => {
  const { handle, reorder, closePreview } = setup()
  fireEvent.keyDown(handle, { key: ' ' })
  expect(screen.getByText('Lifted Army family, position 1 of 2')).toBeTruthy()
  expect(document.body.classList.contains('plate-dragging')).toBe(true)
  expect(closePreview).toHaveBeenCalledOnce()
  fireEvent.keyDown(handle, { key: 'ArrowDown' })
  fireEvent.keyDown(handle, { key: 'ArrowDown' })
  expect(screen.getByText('Moved to position 2')).toBeTruthy()
  fireEvent.keyDown(handle, { key: ' ' })
  await waitFor(() => expect(screen.getByText('Dropped')).toBeTruthy())
  expect(reorder).toHaveBeenCalledExactlyOnceWith(a.state, ['AK.b', 'AK.a', 'AK.v', 'AK.w'])
  expect(document.body.classList.contains('plate-dragging')).toBe(false)
})
test('escape cancels and filters and roles prevent lifting', () => {
  const { handle, reorder } = setup()
  fireEvent.keyDown(handle, { key: ' ' })
  fireEvent.keyDown(handle, { key: 'Escape' })
  expect(screen.getByText('Cancelled')).toBeTruthy()
  expect(reorder).not.toHaveBeenCalled()
  expect(document.body.classList.contains('plate-dragging')).toBe(false)
  cleanup()
  const filtered = setup({ show: 'changed' })
  fireEvent.keyDown(filtered.handle, { key: ' ' })
  expect(screen.queryByText(/Lifted/)).toBeNull()
  expect(filtered.handle.title).toBe('Clear filters to reorder')
  cleanup()
  const readonly = setup({ canEdit: false })
  fireEvent.keyDown(readonly.handle, { key: ' ' })
  expect(screen.queryByText(/Lifted/)).toBeNull()
  cleanup()
  const searched = setup({ query: 'Army' })
  fireEvent.keyDown(searched.handle, { key: ' ' })
  expect(screen.queryByText(/Lifted/)).toBeNull()
})
test('failed reorder snaps back, announces the error and reloads', async () => {
  const { handle, reload } = setup({ error: true })
  fireEvent.keyDown(handle, { key: ' ' })
  fireEvent.keyDown(handle, { key: 'ArrowDown' })
  fireEvent.keyDown(handle, { key: 'ArrowDown' })
  fireEvent.keyDown(handle, { key: ' ' })
  await waitFor(() => expect(screen.getByText('This Batch changed. Drag again to choose a position in the latest order.')).toBeTruthy())
  expect(reload).toHaveBeenCalledOnce()
  expect(screen.getByTestId('order').textContent).toBe('')
})
test('pointer merge edits the family fields and preserves a subthreshold click', async () => {
  const { handle, edit, reorder } = setup({ merge: true, variant: true })
  const pointer = (type: string, x: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 100, button: 0 })
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
    act(() => { (type === 'pointerdown' ? handle : window).dispatchEvent(event) })
  }
  pointer('pointerdown', 100)
  pointer('pointermove', 103)
  expect(document.body.classList.contains('plate-dragging')).toBe(false)
  pointer('pointerup', 103)
  pointer('pointerdown', 100)
  pointer('pointermove', 110)
  pointer('pointerup', 110)
  await waitFor(() => expect(edit).toHaveBeenCalledExactlyOnceWith(v, { templateRole: 'variant', variantOfPlateId: b.id, templateFamily: b.templateFamily ?? b.id }))
  expect(reorder).not.toHaveBeenCalled()
})

test('touch lifts only after the long press and unmount cleans the cursor', () => {
  vi.useFakeTimers()
  try {
    const { handle } = setup()
    const event = new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100 })
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'touch' } })
    act(() => { handle.dispatchEvent(event) })
    act(() => { vi.advanceTimersByTime(399) })
    expect(document.body.classList.contains('plate-dragging')).toBe(false)
    act(() => { vi.advanceTimersByTime(1) })
    expect(document.body.classList.contains('plate-dragging')).toBe(true)
    cleanup()
    expect(document.body.classList.contains('plate-dragging')).toBe(false)
  } finally { vi.useRealTimers() }
})

test('a family cannot merge into another family', async () => {
  const { handle, edit, reorder } = setup({ merge: true })
  for (const [type, x] of [['pointerdown', 100], ['pointermove', 110], ['pointerup', 110]] as const) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 100, button: 0 })
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
    act(() => { (type === 'pointerdown' ? handle : window).dispatchEvent(event) })
  }
  expect(screen.getByText('Cancelled')).toBeTruthy()
  expect(edit).not.toHaveBeenCalled()
  expect(reorder).not.toHaveBeenCalled()
})

test('dragging a variant out sends promotion and order together', async () => {
  const { handle, edit, reorder, move } = setup({ variant: true })
  for (const [type, x] of [['pointerdown', 100], ['pointermove', 110], ['pointerup', 110]] as const) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 100, button: 0 })
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
    act(() => { (type === 'pointerdown' ? handle : window).dispatchEvent(event) })
  }
  await waitFor(() => expect(screen.getByText('Dropped')).toBeTruthy())
  expect(move).toHaveBeenCalledExactlyOnceWith(v.state, ['AK.a', 'AK.w', 'AK.b', 'AK.v'], { plateId: v.id, templateFamily: 'ak_v' }, { batchId: 'batch', revision: 4 })
  expect(edit).not.toHaveBeenCalled()
  expect(reorder).not.toHaveBeenCalled()
})

test('a failed promotion does not send a reorder', async () => {
  const { handle, move, reorder } = setup({ variant: true })
  move.mockResolvedValue({ ok: false, error: 'forbidden' })
  for (const [type, x] of [['pointerdown', 100], ['pointermove', 110], ['pointerup', 110]] as const) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 100, button: 0 })
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
    act(() => { (type === 'pointerdown' ? handle : window).dispatchEvent(event) })
  }
  await waitFor(() => expect(screen.getByText("Only the batch's creator or an Owner can edit it.")).toBeTruthy())
  expect(reorder).not.toHaveBeenCalled()
  expect(screen.getByTestId('order').textContent).toBe('')
})

test('a family without variants can merge back into another family', async () => {
  const { handle, edit, reorder } = setup({ singleton: true, merge: true })
  for (const [type, x] of [['pointerdown', 100], ['pointermove', 110], ['pointerup', 110]] as const) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 100, button: 0 })
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
    act(() => { (type === 'pointerdown' ? handle : window).dispatchEvent(event) })
  }
  await waitFor(() => expect(edit).toHaveBeenCalledExactlyOnceWith(b, { templateRole: 'variant', variantOfPlateId: a.id, templateFamily: a.templateFamily }))
  expect(reorder).not.toHaveBeenCalled()
})

test('new family slugs use state and plate slug and avoid state collisions', () => {
  const plate = { ...v, state: 'AK', id: 'AK.air_force' }
  expect(newFamilySlug(plate, families)).toBe('ak_air_force')
  const occupied = [{ template: { ...a, state: 'AK', templateFamily: 'ak_air_force' }, variants: [{ ...v, state: 'AK', templateFamily: 'ak_air_force_2' }] }]
  expect(newFamilySlug(plate, occupied)).toBe('ak_air_force_3')
  expect(newFamilySlug(plate, [{ template: { ...a, state: 'MD', templateFamily: 'ak_air_force' }, variants: [] }])).toBe('ak_air_force')
})

test('card handles respect entrance animations and global keyboard survives source unmount', async () => {
  const reorder = vi.fn().mockResolvedValue(success)
  function Cards() {
    const drag = usePlateDrag({ families, canEdit: true, show: 'all', query: '', edits: { edit: vi.fn(), pending: false }, ordering: { reorder, pending: false }, targets: () => [], closePreview: vi.fn(), reload: vi.fn() })
    return <><FamilyCard template={a} variants={[v, w]} drag={drag} canEdit number={1} /><output>{drag.announcement}</output></>
  }
  render(<Cards />)
  const article = screen.getByRole('article')
  const handle = document.querySelector<HTMLElement>('[data-plate-row="AK.a"]')!
  const image = article.querySelector('[data-plate-image]')!
  image.getAnimations = () => [{ playState: 'running', pending: false }] as Animation[]
  fireEvent.keyDown(handle, { key: ' ', shiftKey: true })
  expect(screen.queryByText(/Lifted/)).toBeNull()
  image.getAnimations = () => []
  fireEvent.keyDown(handle, { key: ' ', shiftKey: true })
  expect(screen.getByText(/Lifted Army/)).toBeTruthy()
  handle.remove()
  fireEvent.keyDown(window, { key: 'ArrowDown' })
  fireEvent.keyDown(window, { key: ' ', shiftKey: true })
  await waitFor(() => expect(reorder).toHaveBeenCalledOnce())
  expect(screen.getByText('Dropped')).toBeTruthy()
})

test('preview families move forward, backward and across row boundaries without leaving a hole', () => {
  const extra = Array.from({ length: 7 }, (_, index) => ({ template: { ...b, id: `AK.extra${index}` }, variants: [] }))
  const grid = [...families, ...extra]
  const forward = reflowForDrop(grid, { kind: 'family', plate: a }, { kind: 'family-slot', index: 6 })!
  expect(forward.families.map(family => family.template.id)).toEqual([b.id, ...extra.slice(0, 4).map(family => family.template.id), a.id, ...extra.slice(4).map(family => family.template.id)])
  expect(forward.placeholder).toEqual({ kind: 'family', id: a.id })
  expect(familyOrder(forward.families)).toEqual(forward.order)
  const backward = reflowForDrop(grid, { kind: 'family', plate: extra[6].template }, { kind: 'family-slot', index: 0 })!
  expect(backward.families[0].template.id).toBe(extra[6].template.id)
  expect(familyOrder(backward.families)).toEqual(backward.order)
  expect(grid[0].template).toBe(a)
})

test('variant previews shift within a family and promotion opens a family gap; merges do not reflow', () => {
  const forward = reflowForDrop(families, { kind: 'variant', plate: v }, { kind: 'variant-slot', familyId: a.id, index: 2 })!
  expect(forward.families[0].variants.map(plate => plate.id)).toEqual([w.id, v.id])
  expect(forward.placeholder).toEqual({ kind: 'variant', id: v.id })
  const backward = reflowForDrop(families, { kind: 'variant', plate: w }, { kind: 'variant-slot', familyId: a.id, index: 0 })!
  expect(backward.families[0].variants.map(plate => plate.id)).toEqual([w.id, v.id])
  const promoted = reflowForDrop(families, { kind: 'variant', plate: v }, { kind: 'family-slot', index: 2 })!
  expect(promoted.families[0].variants.map(plate => plate.id)).toEqual([w.id])
  expect(promoted.families[2]).toEqual({ template: v, variants: [] })
  expect(familyOrder(promoted.families)).toEqual(promoted.order)
  expect(reflowForDrop(families, { kind: 'variant', plate: v }, { kind: 'merge', familyId: b.id })).toBeNull()
})

test('keyboard arrows update the gap, cancel restores it, and drop commits exactly the preview', async () => {
  const { handle, reorder } = setup()
  fireEvent.keyDown(handle, { key: ' ' })
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  const preview = screen.getByTestId('gap').textContent!.split(',')
  expect(preview).toEqual([b.id, a.id, v.id, w.id])
  fireEvent.keyDown(handle, { key: 'Escape' })
  expect(screen.getByTestId('gap').textContent).toBe('')
  expect(reorder).not.toHaveBeenCalled()
  fireEvent.keyDown(handle, { key: ' ' })
  fireEvent.keyDown(handle, { key: 'ArrowRight' })
  fireEvent.keyDown(handle, { key: ' ' })
  await waitFor(() => expect(reorder).toHaveBeenCalledExactlyOnceWith(a.state, preview))
})

test('pointer movement within the same slot retains the memoized preview', () => {
  const previews: unknown[] = []
  function Harness() {
    const drag = usePlateDrag({ families, canEdit: true, show: 'all', query: '', edits: { edit: vi.fn(), pending: false }, ordering: { reorder: vi.fn(), pending: false }, reload: vi.fn(), closePreview: vi.fn(), targets: () => [{ target: { kind: 'family-slot', index: 2 }, rect: { left: 0, top: 0, right: 500, bottom: 500 } }] })
    if (drag.active) previews.push(drag.reflow)
    return <button onPointerDown={event => drag.onPointerDown({ kind: 'family', plate: a }, event)}>Move</button>
  }
  render(<Harness />)
  for (const [type, x] of [['pointerdown', 100], ['pointermove', 110], ['pointermove', 120], ['pointermove', 130]] as const) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 100, button: 0 })
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
    act(() => { (type === 'pointerdown' ? screen.getByRole('button') : window).dispatchEvent(event) })
  }
  expect(previews.length).toBeGreaterThanOrEqual(3)
  expect(previews.every(preview => preview === previews[0])).toBe(true)
  expect(sameDropTarget({ kind: 'family-slot', index: 2 }, { kind: 'family-slot', index: 2 })).toBe(true)
  expect(sameDropTarget({ kind: 'merge', familyId: a.id }, { kind: 'merge', familyId: b.id })).toBe(false)
})

test('FLIP animates only moved cards diagonally and skips reduced motion', () => {
  const root = document.createElement('div')
  const first = document.createElement('div')
  const second = document.createElement('div')
  first.dataset.reflowKey = a.id
  second.dataset.reflowKey = b.id
  root.append(first, second)
  let left = 0
  let top = 0
  first.getBoundingClientRect = () => ({ left, top }) as DOMRect
  second.getBoundingClientRect = () => ({ left: 200, top: 0 }) as DOMRect
  const cancel = vi.fn()
  first.animate = vi.fn().mockReturnValue({ cancel })
  second.animate = vi.fn()
  const before = measureDragPositions(root)
  left = 220
  top = 300
  playDragFlip(root, before, false)
  expect(first.animate).toHaveBeenCalledExactlyOnceWith([{ transform: 'translate(-220px, -300px)' }, { transform: 'translate(0px, 0px)' }], { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' })
  expect(second.animate).not.toHaveBeenCalled()
  vi.mocked(first.animate).mockClear()
  playDragFlip(root, before, true)
  expect(first.animate).not.toHaveBeenCalled()
})

test('placeholder preserves height and lifted copy preserves the grab point', () => {
  const size = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(134)
  render(<><DragPlaceholder height={312} /><DragPreview item={{ kind: 'family', plate: a }} x={400} y={300} geometry={{ width: 220, height: 312, offsetX: 30, offsetY: 20, imageWidth: 140, imageHeight: 70 }} /></>)
  expect(document.querySelector<HTMLElement>('[data-drag-placeholder]')!.style.height).toBe('312px')
  const lifted = document.querySelector<HTMLElement>('[data-drag-lifted]')!
  expect(lifted.style.transform).toBe('translate3d(370px, 280px, 0) scale(1.03)')
  expect(lifted.textContent).toContain(a.displayName)
  expect(lifted.style.minHeight).toBe('')
  size.mockRestore()
})

test.each([0, 1, 12])('family preview displays %i variants and clamps a low grab point', variantCount => {
  const size = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(134)
  render(<DragPreview item={{ kind: 'family', plate: a }} variantCount={variantCount} x={400} y={500} geometry={{ width: 220, height: 900, offsetX: 30, offsetY: 800, imageWidth: 140, imageHeight: 70 }} />)
  const lifted = document.querySelector<HTMLElement>('[data-drag-lifted]')!
  expect(lifted.style.minHeight).toBe('')
  expect(lifted.style.width).toBe('220px')
  expect(lifted.style.transformOrigin).toBe('30px 134px')
  expect(lifted.style.transform).toBe('translate3d(370px, 366px, 0) scale(1.03)')
  if (variantCount) {
    const pill = screen.getByText(`${variantCount} ${variantCount === 1 ? 'variant' : 'variants'}`)
    expect(pill.parentElement).toBe(screen.getByText(a.displayName).parentElement)
  } else expect(lifted.textContent).not.toContain('variant')
  size.mockRestore()
})

test('variant preview has no family count or stale full-card height', () => {
  render(<DragPreview item={{ kind: 'variant', plate: v }} variantCount={12} x={400} y={300} />)
  const lifted = document.querySelector<HTMLElement>('[data-drag-lifted]')!
  expect(lifted.textContent).not.toContain('variants')
  expect(lifted.style.minHeight).toBe('')
})

test('slot targets remain stable as cards reflow under a stationary pointer and follow scrolling', () => {
  const stable = createStableDragTargets()
  const target = { kind: 'family-slot' as const, index: 4 }
  const initial = [{ target, rect: { left: 300, right: 328, top: 100, bottom: 400 } }, { target, rect: { left: 344, right: 372, top: 100, bottom: 400 } }]
  stable(initial, 0, 0)
  for (let step = 0; step < 8; step++) {
    const moved = initial.map(entry => ({ ...entry, rect: { ...entry.rect, left: 100, right: 128 } }))
    expect(targetAt(350, 200, stable(moved, 0, 0))).toEqual(target)
  }
  expect(targetAt(350, 100, stable([], 0, 100))).toEqual(target)
})

test('cap uses the rendered sixth row, including unequal row heights and gaps', () => {
  const sizes = [80, 130, 65, 160, 90, 140]
  let start = 0
  const rows = sizes.map(size => { const row = { start, size }; start += size + 12; return row })
  expect(variantListCap(rows.slice(0, 5))).toBeUndefined()
  expect(variantListCap(rows)).toBe(655)
  expect(VARIANT_ROW_HEIGHT).toBe(62)
  expect(VARIANT_ROW_GAP).toBe(8)
  expect(estimatedFamilyHeight(6) - estimatedFamilyHeight(5)).toBe(39)
  expect(estimatedFamilyHeight(100)).toBe(estimatedFamilyHeight(6))
  expect(estimatedFamilyHeight(5)).toBeLessThan(estimatedFamilyHeight(6))
})

test('five variants stay uncapped; six show five measured rows and half the sixth', () => {
  const observe = vi.fn()
  let resized = () => {}
  vi.stubGlobal('ResizeObserver', class { callback: () => void; constructor(callback: () => void) { this.callback = callback } observe = (element: HTMLElement) => { if (element.hasAttribute('data-variant-index')) { resized = this.callback; observe(element) } }; disconnect() {} })
  const sizes = [80, 130, 65, 160, 90, 140]
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const index = Number(this.dataset.variantIndex ?? -1)
    return { top: index < 0 ? 0 : sizes.slice(0, index).reduce((sum, size) => sum + size + 12, 0), height: sizes[index] ?? 0, width: 240 } as DOMRect
  })
  try {
    const variants = sizes.map((_, index) => ({ ...v, id: `AK.variant${index}` }))
    const view = render(<FamilyCard template={a} variants={variants.slice(0, 5)} />)
    expect(view.container.querySelector('[data-variant-scroll]')).toBeNull()
    view.rerender(<FamilyCard template={a} variants={variants} />)
    const list = view.container.querySelector<HTMLElement>('[data-variant-scroll]')!
    expect(list.style.height).toBe('655px')
    expect(list.className).toContain('overflow-y-auto')
    expect(list.className).toContain('[scrollbar-gutter:stable]')
    expect(list.className).not.toContain('overscroll-contain')
    expect(observe).toHaveBeenCalledTimes(6)
    sizes[5] = 200
    act(() => resized())
    expect(list.style.height).toBe('685px')
  } finally { bounds.mockRestore(); vi.unstubAllGlobals() }
})

test('nested virtualization observes the list scroll element and retains the first six measurement rows', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  try {
    const plates = Array.from({ length: 30 }, (_, index) => ({ ...v, id: `AK.variant${index}` }))
    const view = render(<VirtualizedVariants familyId={a.id} plates={plates} renderPlate={plate => <a href={'/plates/' + plate.id}>{plate.id}</a>} />)
    const options = vi.mocked(useVirtualizer).mock.calls.at(-1)![0]
    expect(options.enabled).toBe(true)
    expect(options.estimateSize(0)).toBe(VARIANT_ROW_HEIGHT)
    expect(options.gap).toBe(VARIANT_ROW_GAP)
    expect(options.getScrollElement()).toBe(view.getByRole('list'))
    expect(options.rangeExtractor!({ startIndex: 20, endIndex: 24, overscan: 2, count: 30 })).toEqual(expect.arrayContaining([0, 1, 2, 3, 4, 5, 20, 24]))
  } finally { vi.unstubAllGlobals() }
})

test('drag auto-scrolls the capped list within its 40 px edges and yields at its ends', () => {
  const list = document.createElement('div')
  list.dataset.variantScroll = a.id
  list.getBoundingClientRect = () => ({ left: 100, right: 300, top: 100, bottom: 600 }) as DOMRect
  let offset = 100
  Object.defineProperty(list, 'scrollTop', { get: () => offset, set: value => { offset = Math.max(0, Math.min(400, value)) } })
  document.body.append(list)
  try {
    expect(scrollDragList(150, 590, a.id)).toBe(true)
    expect(offset).toBe(109)
    expect(scrollDragList(150, 110, a.id)).toBe(true)
    expect(offset).toBe(100)
    expect(scrollDragList(150, 350, a.id)).toBe(false)
    expect(scrollDragList(350, 590, a.id)).toBe(false)
    offset = 400
    expect(scrollDragList(150, 590, a.id)).toBe(false)
  } finally { list.remove() }
})

test('nested scroll targets follow list scrolling, clip hidden slots and retain boundary stability', () => {
  const list = document.createElement('div')
  list.getBoundingClientRect = () => ({ left: 100, right: 300, top: 100, bottom: 600 }) as DOMRect
  const stable = createStableDragTargets()
  const target = { kind: 'variant-slot' as const, familyId: a.id, index: 8 }
  const targets = [{ target, scrollElement: list, rect: { left: 100, right: 300, top: 800, bottom: 840 } }]
  expect(targetAt(150, 820, stable(targets, 0, 0))).toBeNull()
  list.scrollTop = 300
  expect(targetAt(150, 520, stable([], 0, 0))).toEqual(target)
  expect(targetAt(150, 520, stable([{ ...targets[0], rect: { left: 100, right: 300, top: 100, bottom: 140 } }], 0, 0))).toEqual(target)
})

test('scrolling the nested list does not create a false FLIP movement', () => {
  const root = document.createElement('div')
  const list = document.createElement('div')
  list.dataset.variantScroll = a.id
  const row = document.createElement('div')
  row.dataset.reflowKey = 'variant:' + v.id
  row.getBoundingClientRect = () => ({ left: 100, top: 500 - list.scrollTop }) as DOMRect
  row.animate = vi.fn()
  list.append(row)
  root.append(list)
  const before = measureDragPositions(root)
  list.scrollTop = 300
  const after = playDragFlip(root, before, false)
  expect(after).toEqual(before)
  expect(row.animate).not.toHaveBeenCalled()
})

test('family and variant ids remain available on hover without visible id lines', () => {
  const { container } = render(<FamilyCard template={a} variants={[v]} />)
  expect(container.querySelector('p.id')).toBeNull()
  expect(container.textContent).not.toContain(a.id)
  expect(container.textContent).not.toContain(v.id)
  expect(container.querySelector('h3[title$="' + a.id + '"]')?.className).toContain('truncate')
  expect(container.querySelector('h3[title$="' + v.id + '"]')?.getAttribute('title')).toBe(v.displayName + ' · ' + v.id)
})

test('handles expose grab and disabled cursors while image hover retains preview', () => {
  const preview = vi.fn()
  function Harness({ query = '' }) {
    const drag = usePlateDrag({ families, canEdit: true, show: 'all', query, edits: { edit: vi.fn(), pending: false }, ordering: { reorder: vi.fn(), pending: false }, reload: vi.fn(), closePreview: vi.fn(), targets: () => [] })
    return <FamilyCard template={a} variants={[v]} canEdit drag={drag} onPreview={preview} />
  }
  const view = render(<Harness />)
  for (const handle of view.container.querySelectorAll('[data-plate-row]')) expect(handle.className).toContain('cursor-grab!')
  expect(screen.queryByRole('button', { name: /^Preview / })).toBeNull()
  fireEvent.pointerEnter(view.container.querySelector('[data-plate-image]')!)
  expect(preview).toHaveBeenCalledWith(a, expect.any(HTMLElement), false)
  view.rerender(<Harness query="army" />)
  for (const handle of view.container.querySelectorAll('[data-plate-row]')) expect(handle.className).toContain('cursor-pointer')
})

test.each([false, true])('deleted plates cannot start keyboard or pointer drags, Variant %s', variant => {
  const { handle, edit, reorder, move } = setup({ deletedSource: true, variant })
  fireEvent.keyDown(handle, { key: ' ' })
  for (const [type, x] of [['pointerdown', 100], ['pointermove', 200], ['pointerup', 200]] as const) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 100, button: 0 })
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
    act(() => { (type === 'pointerdown' ? handle : window).dispatchEvent(event) })
  }
  expect(screen.queryByText(/Lifted/)).toBeNull()
  expect(edit).not.toHaveBeenCalled()
  expect(reorder).not.toHaveBeenCalled()
  expect(move).not.toHaveBeenCalled()
})

test('deleted Templates cannot receive a merge', async () => {
  const { handle, edit, reorder } = setup({ deletedDestination: true, merge: true, variant: true })
  for (const [type, x] of [['pointerdown', 100], ['pointermove', 200], ['pointerup', 200]] as const) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 100, button: 0 })
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
    act(() => { (type === 'pointerdown' ? handle : window).dispatchEvent(event) })
  }
  await waitFor(() => expect(screen.getByText('Cancelled')).toBeTruthy())
  expect(edit).not.toHaveBeenCalled()
  expect(reorder).not.toHaveBeenCalled()
})

test('deleted cards and Variants expose disabled handles and no drop targets', () => {
  const deleted = { ...b, deleted: true }
  const deletedVariant = { ...v, deleted: true }
  const view = render(<section><FamilyCard template={a} variants={[deletedVariant, w]} canEdit /><FamilyCard template={deleted} variants={[]} canEdit /></section>)
  expect(document.querySelector<HTMLElement>('[data-plate-row="AK.b"]')!.getAttribute('aria-disabled')).toBe('true')
  expect(view.container.querySelector('[data-drag-handle-id="AK.v"]')?.getAttribute('aria-disabled')).toBe('true')
  const targets = collectDragTargets(view.container, [{ template: a, variants: [deletedVariant, w] }, { template: deleted, variants: [] }])
  expect(targets.some(({ target }) => target.kind === 'merge' && target.familyId === b.id)).toBe(false)
  expect(targets.some(({ target }) => target.kind === 'variant-slot' && target.index === 0)).toBe(false)
})

function pointerDrag(handle: HTMLElement, x: number) {
  for (const [type, position] of [['pointerdown', 100], ['pointermove', x], ['pointerup', x]] as const) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: position, clientY: 100, button: 0 })
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
    act(() => { (type === 'pointerdown' ? handle : window).dispatchEvent(event) })
  }
}

test('background drop promotes selected variants and ignores selected templates', async () => {
  plateSelection.visible([a, v, w])
  plateSelection.add([a, v, w])
  const { handle, edit, reorder, move } = setup({ variant: true })
  pointerDrag(handle, 700)
  await waitFor(() => expect(move).toHaveBeenCalledTimes(2))
  expect(edit).not.toHaveBeenCalled()
  expect(move).toHaveBeenCalledWith(v.state, [a.id, b.id, v.id, w.id], { plateId: v.id, templateFamily: 'ak_v' }, expect.any(Object))
  expect(move).toHaveBeenCalledWith(w.state, [a.id, b.id, v.id, w.id], { plateId: w.id, templateFamily: 'ak_w' }, expect.any(Object))
  expect(reorder).not.toHaveBeenCalled()
  await waitFor(() => expect(screen.getByText('2 plates are now Templates')).toBeTruthy())
})

test('multi-drag edits each selected plate into the destination family', async () => {
  plateSelection.add([v, w])
  const { handle, edit } = setup({ variant: true, merge: true })
  pointerDrag(handle, 110)
  await waitFor(() => expect(edit).toHaveBeenCalledTimes(2))
  for (const plate of [v, w]) expect(edit).toHaveBeenCalledWith(plate, { templateRole: 'variant', templateFamily: b.templateFamily || b.id, variantOfPlateId: b.id })
})

test('selected family-slot drags retain the family reorder path', async () => {
  plateSelection.add([a, v])
  const { handle, edit, reorder, move } = setup()
  pointerDrag(handle, 110)
  await waitFor(() => expect(reorder).toHaveBeenCalledOnce())
  expect(edit).not.toHaveBeenCalled()
  expect(move).not.toHaveBeenCalled()
})

test('multi-merge skips templates with variants instead of moving their children', async () => {
  plateSelection.add([a, v])
  const { handle, edit } = setup({ variant: true, merge: true })
  pointerDrag(handle, 110)
  await waitFor(() => expect(screen.getByText(/Skipped 1 Templates with Variants/)).toBeTruthy())
  expect(edit).toHaveBeenCalledExactlyOnceWith(v, { templateRole: 'variant', templateFamily: b.templateFamily || b.id, variantOfPlateId: b.id })
})

test.each([false, true])('partial merge stops after its first failed chunk and compensates saved edits (revert failure: %s)', async revertFails => {
  const x = { ...v, id: 'AK.x' }, y = { ...v, id: 'AK.y' }
  plateSelection.add([v, w, x, y])
  const save = vi.fn()
    .mockResolvedValueOnce({ ok: true, revision: 'new-v', batchId: 'batch', proposed: {} })
    .mockResolvedValueOnce({ ok: false, error: 'forbidden' })
    .mockResolvedValueOnce({ ok: true, revision: 'new-x', batchId: 'batch', proposed: {} })
    .mockResolvedValue({ ok: !revertFails })
  const { handle, reload } = setup({ variant: true, merge: true, save })
  pointerDrag(handle, 110)
  await waitFor(() => expect(screen.getByText(revertFails ? '2 of 4 saved' : 'Saved 2 of 4; changes undone')).toBeTruthy())
  expect(save).toHaveBeenCalledTimes(5)
  expect(save).not.toHaveBeenCalledWith(y, expect.anything())
  expect(save).toHaveBeenCalledWith({ ...v, revision: 'new-v' }, { templateRole: v.templateRole, templateFamily: v.templateFamily, variantOfPlateId: v.variantOfPlateId }, { batchId: 'batch', baseRevision: 'new-v' })
  expect(plateSelection.snapshot().map(plate => plate.id)).toEqual(revertFails ? [v.id, w.id, x.id, y.id] : [w.id, y.id])
  expect(reload).toHaveBeenCalled()
})

test('promotion de-duplicates slugs across the selection and advances full State orders', async () => {
  const template = { ...a, templateFamily: 'ak_v' }
  const second = { ...w, id: 'AK.v_2' }
  plateSelection.add([v, second])
  const move = vi.fn().mockResolvedValue(success)
  function Harness() {
    const drag = usePlateDrag({ families: [{ template, variants: [v, second] }], canEdit: true, show: 'all', query: '', edits: { edit: vi.fn(), pending: false }, ordering: { reorder: vi.fn(), move, capture: () => ({ batchId: 'batch', revision: move.mock.calls.length + 1 }), pending: false }, targets: () => [], closePreview: vi.fn(), reload: vi.fn().mockResolvedValue(undefined) })
    return <button onClick={() => void drag.promote()}>Promote</button>
  }
  render(<Harness />)
  fireEvent.click(screen.getByRole('button'))
  await waitFor(() => expect(move).toHaveBeenCalledTimes(2))
  expect(move).toHaveBeenNthCalledWith(1, v.state, [a.id, v.id, second.id], { plateId: v.id, templateFamily: 'ak_v_2' }, { batchId: 'batch', revision: 1 })
  expect(move).toHaveBeenNthCalledWith(2, second.state, [a.id, v.id, second.id], { plateId: second.id, templateFamily: 'ak_v_2_2' }, { batchId: 'batch', revision: 2 })
})

test('failed promotion restores saved fields with their new revision and restores State order', async () => {
  plateSelection.add([v, w])
  const move = vi.fn().mockResolvedValueOnce({ ok: true, revision: 'promoted-v', batchId: 'batch' }).mockResolvedValueOnce({ ok: false, error: 'superseded_revision' })
  const edit = vi.fn().mockResolvedValue(success), reorder = vi.fn().mockResolvedValue(success)
  function Harness() {
    const drag = usePlateDrag({ families, canEdit: true, show: 'all', query: '', edits: { edit, pending: false }, ordering: { reorder, move, capture: () => ({ batchId: 'batch', revision: 1 }), pending: false }, targets: () => [], closePreview: vi.fn(), reload: vi.fn().mockResolvedValue(undefined) })
    return <><button onClick={() => void drag.promote()}>Promote</button><output>{drag.announcement}</output></>
  }
  render(<Harness />)
  fireEvent.click(screen.getByRole('button'))
  await waitFor(() => expect(screen.getByText('Saved 1 of 2; changes undone')).toBeTruthy())
  expect(edit).toHaveBeenCalledExactlyOnceWith({ ...v, revision: 'promoted-v' }, { templateRole: v.templateRole, templateFamily: v.templateFamily, variantOfPlateId: v.variantOfPlateId }, { batchId: 'batch', baseRevision: 'promoted-v' })
  expect(reorder).toHaveBeenCalledExactlyOnceWith(v.state, familyOrder(families))
  expect(plateSelection.snapshot().map(plate => plate.id)).toEqual([w.id])
})

test('drag preview only adds an absolutely positioned count for multi-selection', () => {
  const item = { kind: 'variant' as const, plate: v }
  const view = render(<DragPreview item={item} x={0} y={0} />)
  expect(document.querySelector('[data-drag-count]')).toBeNull()
  view.rerender(<DragPreview item={item} x={0} y={0} selectionCount={2} />)
  const count = document.querySelector('[data-drag-count]')!
  expect(count.textContent).toBe('2')
  expect(count.getAttribute('aria-label')).toBe('2 plates')
  expect(count.className).toContain('absolute')
  expect(document.querySelector('[data-drag-lifted]')!.className).toContain('drag-stack')
})

test('multi-merge displays the invalid outline when selected templates still have variants', () => {
  plateSelection.add([a, v])
  function Harness() {
    const drag = usePlateDrag({ families, canEdit: true, show: 'all', query: '', edits: { edit: vi.fn(), pending: false }, ordering: { reorder: vi.fn(), pending: false }, targets: () => [{ target: { kind: 'merge', familyId: b.id }, rect: { left: 0, right: 500, top: 0, bottom: 500 } }], closePreview: vi.fn(), reload: vi.fn() })
    return <><button onPointerDown={event => drag.onPointerDown({ kind: 'variant', plate: v }, event)}>Handle</button><FamilyCard template={b} variants={[]} drag={drag} /></>
  }
  const view = render(<Harness />)
  const handle = screen.getByRole('button', { name: 'Handle' })
  for (const [type, x] of [['pointerdown', 100], ['pointermove', 110]] as const) {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 100, button: 0 })
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
    act(() => (type === 'pointerdown' ? handle : window).dispatchEvent(event))
  }
  expect(view.container.querySelector('article')?.className).toContain('outline-dashed')
})

test('multi-merge skips selected plates from other States', async () => {
  const foreign = { ...w, id: 'NY.foreign', state: 'NY' }
  plateSelection.add([v, foreign])
  const { handle, edit } = setup({ variant: true, merge: true })
  pointerDrag(handle, 110)
  await waitFor(() => expect(screen.getByText(/Skipped 1 plates from other states/)).toBeTruthy())
  expect(edit).toHaveBeenCalledExactlyOnceWith(v, { templateRole: 'variant', templateFamily: b.templateFamily || b.id, variantOfPlateId: b.id })
  expect(plateSelection.snapshot().map(plate => plate.id)).toEqual([foreign.id])
})

test('background drop with only Templates selected reports No Variants selected', async () => {
  plateSelection.add([a, b])
  const { handle, edit, move, reorder } = setup()
  pointerDrag(handle, 700)
  await waitFor(() => expect(screen.getByText('No Variants selected')).toBeTruthy())
  expect(edit).not.toHaveBeenCalled()
  expect(move).not.toHaveBeenCalled()
  expect(reorder).not.toHaveBeenCalled()
})

test('deleted destinations are checked before multi-merge and never promote the selection', async () => {
  plateSelection.add([v, w])
  const { handle, edit, move } = setup({ variant: true, merge: true, deletedDestination: true })
  pointerDrag(handle, 110)
  await waitFor(() => expect(screen.getByText('Cancelled')).toBeTruthy())
  expect(edit).not.toHaveBeenCalled()
  expect(move).not.toHaveBeenCalled()
})

test('deleted plate row and modifier selection are disabled', () => {
  const deleted = { ...v, deleted: true }
  plateSelection.visible([deleted])
  const view = render(<FamilyCard template={a} variants={[deleted]} matches={() => true} />)
  expect(view.container.querySelector('[data-plate-row="AK.v"]')?.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(view.container.querySelector('h3[title$="' + v.id + '"] a')!, { ctrlKey: true })
  expect(plateSelection.snapshot()).toEqual([])
})

test('bulk moves exclude plates deleted after selection was captured', async () => {
  const deleted = { ...w, deleted: false }
  plateSelection.add([v, deleted])
  deleted.deleted = true
  const { handle, edit } = setup({ variant: true, merge: true })
  pointerDrag(handle, 110)
  await waitFor(() => expect(screen.getByText('1 plate moved')).toBeTruthy())
  expect(edit).toHaveBeenCalledExactlyOnceWith(v, { templateRole: 'variant', templateFamily: b.templateFamily || b.id, variantOfPlateId: b.id })
})

test('titles and checks share the details container beside each image', () => {
  const view = render(<FamilyCard template={a} variants={[v]} canEdit />)
  const details = view.container.querySelectorAll('.family-plate-details')
  expect(details).toHaveLength(2)
  details.forEach(detail => {
    expect(detail.querySelector('h3')).not.toBeNull()
    expect(detail.querySelector('[data-check-strip]')).not.toBeNull()
    expect(detail.parentElement?.querySelector('[data-plate-image]')).not.toBeNull()
  })
  expect(view.container.querySelectorAll('[data-plate-row][tabindex="0"]')).toHaveLength(2)
})


test('row clicks select, link clicks open, and keyboard selection stays distinct from movement', () => {
  plateSelection.visible([a, v, w])
  const view = render(<FamilyCard template={a} variants={[v, w]} canEdit />)
  const row = view.container.querySelector<HTMLElement>('[data-plate-row="AK.v"]')!
  expect(row).not.toBeNull()
  fireEvent.click(row)
  expect(row.getAttribute('data-selected')).toBe('true')
  fireEvent.click(view.container.querySelector('[data-plate-row="AK.w"]')!, { ctrlKey: true })
  expect(plateSelection.snapshot().map(plate => plate.id)).toEqual([v.id, w.id])
  fireEvent.keyDown(row, { key: ' ' })
  expect(plateSelection.snapshot().map(plate => plate.id)).toEqual([w.id])
  const imageLink = row.querySelector('a[data-plate-open]')!
  imageLink.addEventListener('click', event => event.preventDefault())
  fireEvent.click(imageLink)
  expect(plateSelection.snapshot().map(plate => plate.id)).toEqual([w.id])
  fireEvent.click(row.querySelector('h3 a')!, { metaKey: true })
  expect(plateSelection.snapshot().map(plate => plate.id)).toEqual([w.id, v.id])
  expect(view.container.querySelector('input[type="checkbox"]')).toBeNull()
  expect(view.container.querySelector('[data-family-handle], [data-variant-handle]')).toBeNull()
})


test('whole rows reuse the pointer threshold and allow a later click after a drag', async () => {
  plateSelection.visible([a, v, w])
  const { handle, move } = setup({ rows: true, variant: true })
  for (const [type, x] of [['pointerdown', 100], ['pointermove', 103], ['pointerup', 103]] as const) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 100, button: 0 })
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
    act(() => { (type === 'pointerdown' ? handle : window).dispatchEvent(event) })
  }
  expect(document.body.classList.contains('plate-dragging')).toBe(false)
  fireEvent.click(handle)
  expect(plateSelection.has(v.id)).toBe(true)
  pointerDrag(handle, 110)
  await waitFor(() => expect(move).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.getByText('Dropped')).toBeTruthy())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  fireEvent.click(document.querySelector('[data-plate-row="AK.v"]')!)
  expect(plateSelection.has(v.id)).toBe(false)
})

test('rows use Space for selection, Enter for opening and Shift+Space for keyboard moves', async () => {
  plateSelection.visible([a, v, w])
  const { handle, reorder } = setup({ rows: true })
  fireEvent.keyDown(handle, { key: ' ' })
  expect(plateSelection.has(a.id)).toBe(true)
  expect(screen.queryByText(/Lifted/)).toBeNull()
  fireEvent.keyDown(handle, { key: 'Enter' })
  expect(push).toHaveBeenCalledWith('/plates/' + a.id)
  fireEvent.keyDown(handle, { key: ' ', shiftKey: true })
  expect(screen.getByText(/Lifted Army family/)).toBeTruthy()
  fireEvent.keyDown(window, { key: 'ArrowDown' })
  fireEvent.keyDown(window, { key: 'ArrowDown' })
  fireEvent.keyDown(window, { key: ' ' })
  await waitFor(() => expect(reorder).toHaveBeenCalledOnce())
})


test('preview opens only on image pointer hover and stays dismissed through pressing and dragging', async () => {
  const preview = vi.fn(), close = vi.fn()
  function Harness() {
    const drag = usePlateDrag({ families, canEdit: true, show: 'all', query: '', edits: { edit: vi.fn(), pending: false }, ordering: { reorder: vi.fn().mockResolvedValue(success), pending: false }, reload: vi.fn(), closePreview: close, targets: () => [] })
    return <><FamilyCard template={a} variants={[v]} canEdit drag={drag} onPreview={preview} onDismissPreview={close} /><output>{drag.announcement}</output></>
  }
  const view = render(<Harness />)
  const row = view.container.querySelector<HTMLElement>('[data-plate-row="AK.v"]')!
  const image = row.querySelector<HTMLElement>('[data-plate-image]')!
  const title = row.querySelector('h3 a')!
  const enter = (element: Element, buttons = 0) => fireEvent(element, new MouseEvent('pointerover', { bubbles: true, buttons }))
  const leave = (element: Element) => fireEvent(element, new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
  enter(row); enter(title)
  fireEvent.focus(row); fireEvent.focus(title); fireEvent.focus(image.closest('a')!)
  expect(preview).not.toHaveBeenCalled()
  enter(image)
  expect(preview).toHaveBeenCalledExactlyOnceWith(v, image, false)
  preview.mockClear(); close.mockClear()
  fireEvent.pointerDown(image)
  expect(close).toHaveBeenCalledOnce()
  fireEvent.click(row)
  expect(preview).not.toHaveBeenCalled()
  leave(image)
  enter(image, 1)
  expect(preview).not.toHaveBeenCalled()
  leave(image)
  enter(image)
  expect(preview).toHaveBeenCalledOnce()
  preview.mockClear()
  pointerDrag(image, 110)
  expect(close).toHaveBeenCalled()
  await waitFor(() => expect(document.body.classList.contains('plate-dragging')).toBe(false))
  expect(close.mock.calls.length).toBeGreaterThanOrEqual(3)
  const restoredImage = view.container.querySelector('[data-plate-row="AK.v"] [data-plate-image]')!
  enter(restoredImage)
  expect(preview).not.toHaveBeenCalled()
  leave(restoredImage)
  enter(restoredImage)
  expect(preview).toHaveBeenCalledOnce()
})


test('a background drop does not swallow the first row click while its save is pending', async () => {
  plateSelection.visible([a, v, w])
  let finish!: (value: typeof success) => void
  const moveSave = vi.fn(() => new Promise<typeof success>(resolve => { finish = resolve }))
  const { handle } = setup({ rows: true, variant: true, moveSave })
  pointerDrag(handle, 110)
  expect(moveSave).toHaveBeenCalledOnce()
  const other = document.querySelector('[data-plate-row="AK.a"]')!
  fireEvent.pointerDown(other, { button: 0 })
  fireEvent.click(other)
  expect(plateSelection.has(a.id)).toBe(true)
  await act(async () => finish(success))
})

test('background drop suppression expires even without another pointerdown', async () => {
  plateSelection.visible([a, v, w])
  const { handle } = setup({ rows: true, variant: true })
  pointerDrag(handle, 110)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  fireEvent.click(document.querySelector('[data-plate-row="AK.a"]')!)
  expect(plateSelection.has(a.id)).toBe(true)
})

test('rows expose checks and selection descriptions without nested button semantics', () => {
  plateSelection.visible([a, v])
  const view = render(<FamilyCard template={a} variants={[v]} />)
  const row = view.container.querySelector('[data-plate-row="AK.a"]')!
  expect(row.getAttribute('role')).toBeNull()
  expect(row.getAttribute('aria-pressed')).toBeNull()
  expect(row.getAttribute('aria-label')).toBeNull()
  expect(row.getAttribute('aria-keyshortcuts')).not.toContain('Shift+Space')
  const imageLink = row.querySelector('a[data-plate-open]')!
  expect(imageLink.getAttribute('tabindex')).toBe('-1')
  expect(imageLink.getAttribute('aria-hidden')).toBe('true')
  expect(row.querySelector('h3 a')?.getAttribute('tabindex')).not.toBe('-1')
  expect(row.querySelectorAll('[data-check][aria-label]')).toHaveLength(7)
  fireEvent.click(row)
  expect(document.getElementById(row.getAttribute('aria-describedby')!)?.textContent).toBe('Selected')
  const key = new KeyboardEvent('keydown', { key: ' ', shiftKey: true, bubbles: true, cancelable: true })
  fireEvent(row, key)
  expect(key.defaultPrevented).toBe(true)
})


test('Undo delete shares the details column instead of squeezing the image and checks', () => {
  const view = render(<FamilyCard template={a} variants={[{ ...v, deleted: true }]} canEdit onUndoDelete={vi.fn()} badge={() => <span>Edited</span>} />)
  const row = view.container.querySelector('[data-plate-row="AK.v"]')!
  expect(row.querySelector('button')?.closest('.family-plate-details')).not.toBeNull()
  expect(row.querySelectorAll('.family-plate-details [data-check]')).toHaveLength(7)
})


test('background placement uses the nearest family slot or the end past the grid', () => {
  const targets = [
    { target: { kind: 'family-slot' as const, index: 1 }, rect: { left: 250, right: 280, top: 0, bottom: 200 } },
    { target: { kind: 'family-slot' as const, index: 2 }, rect: { left: 550, right: 580, top: 0, bottom: 200 } },
  ]
  expect(nearestFamilySlot(290, 100, targets, 2)).toBe(1)
  expect(nearestFamilySlot(900, 100, targets, 2)).toBe(2)
  expect(nearestFamilySlot(10, 400, targets, 2)).toBe(2)
  expect(promotionOrder(families, [v.id, w.id], 1)).toEqual([a.id, v.id, w.id, b.id])
  expect(promotionOrder(families, [v.id], undefined)).toEqual([a.id, w.id, v.id, b.id])
})

test('move buttons exclude deleted, foreign, blocked and fully selected families', () => {
  const foreign = { ...b, id: 'NY.b', state: 'NY' }
  plateSelection.register([a, v, w, b, foreign])
  plateSelection.visible([a, v, w, b, foreign])
  function Harness() {
    const drag = usePlateDrag({ families, canEdit: true, show: 'all', query: '', edits: { edit: vi.fn(), pending: false }, ordering: { reorder: vi.fn(), pending: false }, targets: () => [], closePreview: vi.fn(), reload: vi.fn() })
    return <><FamilyCard template={a} variants={[v, w]} canEdit drag={drag} /><FamilyCard template={{ ...b, deleted: true }} variants={[]} canEdit drag={drag} /><FamilyCard template={foreign} variants={[]} canEdit drag={drag} /></>
  }
  const view = render(<Harness />)
  act(() => plateSelection.add([a]))
  expect(screen.queryByRole('button', { name: /Move .* here/ })).toBeNull()
  expect(view.container.querySelector('[data-drag-family="AK.a"]')?.className).toContain('ring-2')
  act(() => plateSelection.add([v, w]))
  expect(screen.queryByRole('button', { name: /Move .* here/ })).toBeNull()
})

test('markers reserve the same details width and stay outside row flow in both sizes', () => {
  const view = render(<FamilyCard template={a} variants={[v]} />)
  const before = [...view.container.querySelectorAll('.family-plate-details')].map(element => element.className)
  view.rerender(<FamilyCard template={a} variants={[v]} badge={() => <span>Edited</span>} />)
  expect([...view.container.querySelectorAll('.family-plate-details')].map(element => element.className)).toEqual(before)
  const markers = view.container.querySelectorAll('[data-batch-marker]')
  expect(markers).toHaveLength(2)
  markers.forEach(marker => {
    expect(marker.className).toContain('absolute top-0 right-0 size-5')
    expect(marker.closest('[data-plate-row]')).not.toBeNull()
  })
})

test('image links prevent native dragging while remaining a row drag surface', () => {
  const view = render(<FamilyCard template={a} variants={[v]} />)
  const imageLink = view.container.querySelector('[data-plate-open]')!
  expect(imageLink.getAttribute('draggable')).toBe('false')
  const event = new MouseEvent('dragstart', { bubbles: true, cancelable: true })
  fireEvent(imageLink, event)
  expect(event.defaultPrevented).toBe(true)
})


test('viewport auto-scroll and wheel scrolling retain a multi-drag and retarget a distant family', async () => {
  const frames: FrameRequestCallback[] = []
  const scrollBy = vi.fn()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('scrollY', 0)
  vi.stubGlobal('scrollBy', scrollBy)
  vi.stubGlobal('innerHeight', 900)
  plateSelection.add([v, w])
  const edit = vi.fn().mockResolvedValue(success)
  try {
    function Harness() {
      const drag = usePlateDrag({ families, canEdit: true, show: 'all', query: '', edits: { edit, pending: false }, ordering: { reorder: vi.fn(), pending: false }, targets: () => [{ target: { kind: 'merge', familyId: b.id }, rect: { left: 50, right: 250, top: 1200 - window.scrollY, bottom: 1400 - window.scrollY } }], closePreview: vi.fn(), reload: vi.fn().mockResolvedValue(undefined) })
      return <><button onPointerDown={event => drag.onPointerDown({ kind: 'variant', plate: v }, event)}>Handle</button><output>{drag.announcement}</output>{drag.active ? <DragPreview {...drag.active} /> : null}</>
    }
    render(<Harness />)
    const handle = screen.getByRole('button', { name: 'Handle' })
    const pointer = (type: string, x: number, y: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
      Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
      act(() => { (type === 'pointerdown' ? handle : window).dispatchEvent(event) })
    }
    pointer('pointerdown', 100, 890)
    pointer('pointermove', 110, 899)
    act(() => frames.shift()!(0))
    expect(scrollBy).toHaveBeenCalledWith(0, expect.any(Number))
    expect(scrollBy.mock.calls[0][1]).toBeGreaterThan(0)
    pointer('pointermove', 110, 350)
    const lifted = document.querySelector<HTMLElement>('[data-drag-lifted]')!
    const position = lifted.style.transform
    fireEvent.wheel(window, { deltaY: 900 })
    vi.stubGlobal('scrollY', 900)
    fireEvent.scroll(window)
    expect(document.body.classList.contains('plate-dragging')).toBe(true)
    expect(lifted.style.transform).toBe(position)
    pointer('pointerup', 110, 350)
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(2))
    for (const plate of [v, w]) expect(edit).toHaveBeenCalledWith(plate, { templateRole: 'variant', variantOfPlateId: b.id, templateFamily: b.templateFamily || b.id })
  } finally { cleanup(); vi.unstubAllGlobals() }
})
