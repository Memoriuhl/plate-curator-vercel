import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { plateSelection } from '../components/dashboard/plate-selection'
import { usePlateDrag } from '../components/dashboard/use-plate-drag'
import { plateCards } from '../fixtures/plate-cards'

const first = { ...plateCards[0], id: 'first', displayName: 'First', isStandard: true, templateRole: 'template' as const }
const second = { ...first, id: 'second', displayName: 'Second', isStandard: false }
const third = { ...second, id: 'third', displayName: 'Third' }
afterEach(() => { cleanup(); plateSelection.clear() })
function setup(source = first) {
  const reorder = vi.fn().mockResolvedValue({ ok: true })
  function Harness() {
    const drag = usePlateDrag({ families: [first, second, third].map(template => ({ template, variants: [] })), canEdit: true, show: 'all', query: '', edits: { edit: vi.fn(), pending: false }, ordering: { reorder, pending: false }, targets: () => [], closePreview: vi.fn(), reload: vi.fn() })
    return <><button onKeyDown={event => drag.onKeyDown({ kind: 'family', plate: source }, event)}>Move</button>{drag.standardDialog}<output>{drag.optimisticOrder?.join(',')}</output></>
  }
  render(<Harness />)
  const handle = screen.getByRole('button', { name: 'Move' })
  const drop = () => {
    fireEvent.keyDown(handle, { key: ' ' })
    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    fireEvent.keyDown(handle, { key: ' ' })
  }
  return { reorder, drop }
}
test('keyboard reorder of the first family confirms before any write; Cancel restores', async () => {
  const { reorder, drop } = setup()
  const handle = screen.getByRole('button', { name: 'Move' })
  handle.focus()
  drop()
  expect(screen.getByRole('alertdialog').textContent).toContain('Make Second the AK Standard?')
  expect(reorder).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(reorder).not.toHaveBeenCalled()
  expect(screen.getByRole('status').textContent).toBe('')
  await waitFor(() => expect(document.activeElement).toBe(handle))
  drop()
  fireEvent.click(screen.getByRole('button', { name: 'Make Standard' }))
  await waitFor(() => expect(reorder).toHaveBeenCalledExactlyOnceWith('AK', ['second', 'first', 'third'], { from: 'first', to: 'second' }))
})
test('reorder below the first family saves without a dialog', async () => {
  const { reorder, drop } = setup(second)
  drop()
  await waitFor(() => expect(reorder).toHaveBeenCalledExactlyOnceWith('AK', ['first', 'third', 'second']))
  expect(screen.queryByRole('alertdialog')).toBeNull()
})

test.each([false, true])('promotion into first place confirms before any write, including multi-drag: %s', async multi => {
  const variant = { ...second, id: 'variant', displayName: 'Variant', templateRole: 'variant' as const }
  const other = { ...variant, id: 'other' }
  const move = vi.fn().mockResolvedValue({ ok: true, proposed: {}, batchId: 'batch', revision: 'saved' })
  function Harness() {
    const drag = usePlateDrag({ families: [{ template: first, variants: [variant, other] }, { template: second, variants: [] }], canEdit: true, show: 'all', query: '', edits: { edit: vi.fn(), pending: false }, ordering: { reorder: vi.fn(), move, capture: () => ({ batchId: 'batch', revision: 0 }), pending: false }, targets: () => [], closePreview: vi.fn(), reload: vi.fn() })
    return <><button onKeyDown={event => drag.onKeyDown({ kind: 'variant', plate: variant }, event)}>Move</button>{drag.standardDialog}</>
  }
  render(<Harness />)
  if (multi) act(() => plateSelection.add([variant, other]))
  const handle = screen.getByRole('button', { name: 'Move' })
  fireEvent.keyDown(handle, { key: ' ' })
  fireEvent.keyDown(handle, { key: 'ArrowLeft' })
  fireEvent.keyDown(handle, { key: ' ' })
  expect(screen.getByRole('alertdialog').textContent).toContain('Make Variant the AK Standard?')
  expect(move).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Make Standard' }))
  await waitFor(() => expect(move).toHaveBeenCalledTimes(multi ? 2 : 1))
  expect(move.mock.calls[0][1][0]).toBe(variant.id)
  expect(move.mock.calls[0][4]).toEqual({ from: first.id, to: variant.id })
})
