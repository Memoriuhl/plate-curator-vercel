import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { plateCards } from '../fixtures/plate-cards'
import { usePlateDrag } from '../components/dashboard/use-plate-drag'
import { FamilyCard } from '../components/plate/family-card'
import { familyOrder, moveBlock, newFamilySlug, orderForDrop, pastDragThreshold, targetAt, scrollVelocity } from '../components/dashboard/drop-targets'
import { reflowForDrop, sameDropTarget } from '../components/dashboard/drag-reflow'
import { measureDragPositions, playDragFlip } from '../components/dashboard/use-drag-flip'
import { DragPlaceholder, DragPreview } from '../components/dashboard/drag-preview'
import { createStableDragTargets } from '../components/dashboard/drag-target-elements'
import { variantListCap, estimatedFamilyHeight } from '../components/dashboard/variant-list-layout'
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
vi.mock('next/navigation', () => ({ useRouter: () => ({ prefetch: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ prefetch, ...props }: Record<string, unknown>) => { void prefetch; return <a {...props} /> } }))
vi.mock('next/image', () => ({ default: () => <span /> }))
afterEach(cleanup)

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
  expect(scrollVelocity(450, 900)).toBe(0)
})

function setup({ show = 'all', query = '', canEdit = true, error = false, merge = false, variant = false, singleton = false } = {}) {
  const edit = vi.fn().mockResolvedValue(success)
  const reorder = vi.fn().mockResolvedValue(error ? { ok: false, error: 'superseded_revision' } : success)
  const reload = vi.fn().mockResolvedValue(undefined)
  const closePreview = vi.fn()
  function Harness() {
    const drag = usePlateDrag({ families, canEdit, show, query, edits: { edit, pending: false }, ordering: { reorder, pending: false }, reload, closePreview,
      targets: () => [{ target: merge ? { kind: 'merge', familyId: singleton ? a.id : b.id } : { kind: 'family-slot', index: 2 }, rect: { left: 0, right: 500, top: 0, bottom: 500 } }],
    })
    const item = { kind: variant ? 'variant' as const : 'family' as const, plate: singleton ? b : variant ? v : a }
    return <><button title={drag.handleTitle} onPointerDown={event => drag.onPointerDown(item, event)} onKeyDown={event => drag.onKeyDown(item, event)} onClick={drag.suppressClick}>Handle</button><output aria-live="polite">{drag.announcement}</output><span data-testid="order">{drag.optimisticOrder?.join(',')}</span><span data-testid="gap">{drag.reflow?.order.join(',')}</span></>
  }
  render(<Harness />)
  return { edit, reorder, reload, closePreview, handle: screen.getByRole('button') }
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
  await waitFor(() => expect(screen.getByText('This batch has a newer revision. Reload and try again.')).toBeTruthy())
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

test('dragging a variant out promotes it before saving the full state order', async () => {
  const { handle, edit, reorder } = setup({ variant: true })
  for (const [type, x] of [['pointerdown', 100], ['pointermove', 110], ['pointerup', 110]] as const) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 100, button: 0 })
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
    act(() => { (type === 'pointerdown' ? handle : window).dispatchEvent(event) })
  }
  await waitFor(() => expect(screen.getByText('Dropped')).toBeTruthy())
  expect(edit).toHaveBeenCalledExactlyOnceWith(v, { templateRole: 'template', variantOfPlateId: null, templateFamily: 'ak_v' })
  expect(reorder).toHaveBeenCalledExactlyOnceWith(v.state, ['AK.a', 'AK.w', 'AK.b', 'AK.v'])
  expect(edit.mock.invocationCallOrder[0]).toBeLessThan(reorder.mock.invocationCallOrder[0])
})

test('a failed promotion does not send a reorder', async () => {
  const { handle, edit, reorder } = setup({ variant: true })
  edit.mockResolvedValue({ ok: false, error: 'forbidden' })
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
  const handle = screen.getByRole('button', { name: 'Move Army family' })
  const image = article.querySelector('[data-plate-image]')!
  image.getAnimations = () => [{ playState: 'running', pending: false }] as Animation[]
  fireEvent.keyDown(handle, { key: ' ' })
  expect(screen.queryByText(/Lifted/)).toBeNull()
  image.getAnimations = () => []
  fireEvent.keyDown(handle, { key: ' ' })
  expect(screen.getByText(/Lifted Army/)).toBeTruthy()
  handle.remove()
  fireEvent.keyDown(window, { key: 'ArrowDown' })
  fireEvent.keyDown(window, { key: ' ' })
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
  expect(estimatedFamilyHeight(100)).toBe(estimatedFamilyHeight(6))
  expect(estimatedFamilyHeight(5)).toBeLessThan(estimatedFamilyHeight(6))
})

test('five variants stay uncapped; six show five measured rows and half the sixth', () => {
  const observe = vi.fn()
  let resized = () => {}
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback } observe = observe; disconnect() {} })
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
