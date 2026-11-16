import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { plateCards } from '../fixtures/plate-cards'
import { usePlateDrag } from '../components/dashboard/use-plate-drag'
import { FamilyCard } from '../components/plate/family-card'
import { familyOrder, moveBlock, newFamilySlug, orderForDrop, pastDragThreshold, targetAt, scrollVelocity } from '../components/dashboard/drop-targets'

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
    return <><button title={drag.handleTitle} onPointerDown={event => drag.onPointerDown(item, event)} onKeyDown={event => drag.onKeyDown(item, event)} onClick={drag.suppressClick}>Handle</button><output aria-live="polite">{drag.announcement}</output><span data-testid="order">{drag.optimisticOrder?.join(',')}</span></>
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
  article.getAnimations = () => [{ playState: 'running', pending: false }] as Animation[]
  fireEvent.keyDown(handle, { key: ' ' })
  expect(screen.queryByText(/Lifted/)).toBeNull()
  article.getAnimations = () => []
  fireEvent.keyDown(handle, { key: ' ' })
  expect(screen.getByText(/Lifted Army/)).toBeTruthy()
  handle.remove()
  fireEvent.keyDown(window, { key: 'ArrowDown' })
  fireEvent.keyDown(window, { key: ' ' })
  await waitFor(() => expect(reorder).toHaveBeenCalledOnce())
  expect(screen.getByText('Dropped')).toBeTruthy()
})
