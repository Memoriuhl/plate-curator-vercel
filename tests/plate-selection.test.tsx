// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SelectionBar } from '@/components/dashboard/selection-bar'
import { usePlateDrag } from '@/components/dashboard/use-plate-drag'
import { JurisdictionCard } from '@/components/dashboard/jurisdiction-card'
import { plateCards } from '../fixtures/plate-cards'
import { Profiler } from 'react'
import { afterEach, vi, describe, it, expect } from 'vitest'
import { createPlateSelection, plateSelection, SelectionPlate, SelectionCheckbox, useSelectionKeyboard } from '@/components/dashboard/plate-selection'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
const plates = ['a', 'b', 'c'].map(id => ({ id, state: 'NY' }) as PlateCardData)
describe('dashboard selection', () => {
  it('selects, toggles, ranges, selects all and clears', () => {
    const store = createPlateSelection()
    store.visible(plates)
    store.select('a')
    expect(store.snapshot().map(p => p.id)).toEqual(['a'])
    store.select('c', { ctrlKey: true })
    expect(store.snapshot()).toHaveLength(2)
    store.select('b', { shiftKey: true })
    expect(store.snapshot().map(p => p.id)).toEqual(['b', 'c'])
    store.select('b')
    expect(store.snapshot().map(p => p.id)).toEqual(['c'])
    store.all()
    expect(store.snapshot()).toHaveLength(3)
    store.clear()
    expect(store.snapshot()).toEqual([])
  })
  it('retains selections across state changes and deduplicates groups', () => {
    const store = createPlateSelection()
    store.visible(plates)
    store.select('a')
    store.visible([{ id: 'd', state: 'NJ' } as PlateCardData])
    store.select('d', { metaKey: true })
    store.add([plates[0]])
    expect(store.snapshot().map(p => p.state)).toEqual(['NY', 'NJ'])
  })
})

afterEach(() => { cleanup(); plateSelection.clear() })
it('modifier clicks select without opening a plate and unrelated plates do not render', () => {
  plateSelection.visible(plates)
  const renderA = vi.fn(), renderB = vi.fn()
  render(<><Profiler id="a" onRender={renderA}><SelectionPlate id="a"><SelectionCheckbox id="a" /><a href="/a">Open A</a></SelectionPlate></Profiler><Profiler id="b" onRender={renderB}><SelectionPlate id="b"><SelectionCheckbox id="b" />B</SelectionPlate></Profiler></>)
  renderA.mockClear(); renderB.mockClear()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select a' }))
  expect((screen.getByRole('checkbox', { name: 'Select a' }) as HTMLInputElement).checked).toBe(true)
  expect(renderA).toHaveBeenCalledTimes(1)
  expect(renderB).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Open A'), { ctrlKey: true })
  expect(plateSelection.has('a')).toBe(false)
  act(() => plateSelection.all())
  expect(plateSelection.snapshot()).toHaveLength(3)
})

it('keyboard selection ignores text inputs and clears on Escape', () => {
  plateSelection.visible(plates)
  const promote = vi.fn().mockResolvedValue(undefined)
  function Harness() { useSelectionKeyboard({ close: vi.fn(), promote, disabled: false }); return <input aria-label="Search" /> }
  render(<Harness />)
  const input = screen.getByRole('textbox')
  fireEvent.keyDown(input, { key: 'a', ctrlKey: true })
  expect(plateSelection.snapshot()).toHaveLength(0)
  fireEvent.keyDown(window, { key: 'a', ctrlKey: true })
  expect(plateSelection.snapshot()).toHaveLength(3)
  fireEvent.keyDown(input, { key: 'Backspace' })
  expect(promote).not.toHaveBeenCalled()
  fireEvent.keyDown(window, { key: 'Delete' })
  expect(promote).toHaveBeenCalledOnce()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(plateSelection.snapshot()).toHaveLength(0)
})

vi.mock('next/navigation', () => ({ useParams: () => ({ code: 'NY' }), useSearchParams: () => new URLSearchParams(), usePathname: () => '/states/NY', useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('@/lib/client/hooks', () => ({ useSelectedBatchId: () => null }))
vi.mock('next/link', () => ({ useLinkStatus: () => ({ pending: false }), default: ({ prefetch, scroll, ...props }: Record<string, unknown>) => { void prefetch; void scroll; return <a {...props} /> } }))

it('groups cross-state selections and outlines the matching jurisdiction', () => {
  plateSelection.add([{ ...plateCards[0], id: 'NY.a', state: 'NY', displayName: 'New York' }, { ...plateCards[0], id: 'NJ.b', state: 'NJ', displayName: 'New Jersey' }])
  render(<><SelectionBar promote={vi.fn()} disabled={false} /><JurisdictionCard jurisdiction={{ code: 'NJ', name: 'New Jersey', region: 'us', plateCount: 1, completeCount: 0, progress: null }} /></>)
  expect(screen.getByRole('link').className).toContain('outline-2')
  fireEvent.click(screen.getByRole('button', { name: '2 selected' }))
  expect(screen.getByRole('heading', { name: 'NY (1)' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'NJ (1)' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
  expect(screen.getByRole('link').className).not.toContain('outline-2')
})

it('Backspace promotes only variants through the edit path and ignores editable focus', async () => {
  const variant = { ...plateCards[0], id: 'NY.variant', templateRole: 'variant' as const }
  const template = { ...variant, id: 'NY.template', templateRole: 'template' as const }
  const edit = vi.fn().mockResolvedValue({ ok: true })
  const move = vi.fn().mockResolvedValue({ ok: true })
  plateSelection.add([template, variant])
  function Harness() {
    const drag = usePlateDrag({ families: [{ template, variants: [variant] }], canEdit: true, show: 'all', query: '', edits: { edit, pending: false }, ordering: { reorder: vi.fn(), move, capture: () => ({ batchId: 'batch', revision: 1 }), pending: false }, targets: () => [], closePreview: vi.fn(), reload: vi.fn() })
    useSelectionKeyboard({ close: vi.fn(), promote: drag.promote, disabled: false })
    return <><textarea aria-label="Notes" /><p>{drag.announcement}</p></>
  }
  render(<Harness />)
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Backspace' })
  expect(edit).not.toHaveBeenCalled()
  await act(async () => fireEvent.keyDown(window, { key: 'Backspace' }))
  expect(edit).not.toHaveBeenCalled()
  expect(move).toHaveBeenCalledExactlyOnceWith(variant.state, [template.id, variant.id], { plateId: variant.id, templateFamily: 'ak_variant' }, { batchId: 'batch', revision: 1 })
  expect(screen.getByText('1 plate is now a Template')).toBeTruthy()
})


it.each(['dialog', 'menu', 'listbox', 'combobox'])('ignores destructive shortcuts and Escape inside %s', role => {
  plateSelection.add(plates)
  const promote = vi.fn(), close = vi.fn()
  function Harness() { useSelectionKeyboard({ close, promote, disabled: false }); return <div role={role}><button>Inside</button></div> }
  render(<Harness />)
  const target = screen.getByRole('button')
  fireEvent.keyDown(target, { key: 'Delete' })
  fireEvent.keyDown(target, { key: 'Escape' })
  expect(promote).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
  expect(plateSelection.snapshot()).toHaveLength(3)
})

it('preserves selection when Escape is handled, in a popover, in an input, or during a drag', () => {
  plateSelection.add(plates)
  const close = vi.fn()
  function Harness({ dragging = false }) {
    useSelectionKeyboard({ close, promote: vi.fn(), disabled: false, dragging })
    return <><input /><div data-radix-popper-content-wrapper><button>Popover</button></div></>
  }
  const view = render(<Harness />)
  for (const target of [screen.getByRole('textbox'), screen.getByRole('button')]) fireEvent.keyDown(target, { key: 'Escape' })
  const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
  handled.preventDefault()
  window.dispatchEvent(handled)
  view.rerender(<Harness dragging />)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
  expect(plateSelection.snapshot()).toHaveLength(3)
})

it('dimmed plates have disabled checkboxes and are excluded from ranges', () => {
  plateSelection.visible([plates[0], plates[2]])
  render(<SelectionPlate id="b" disabled><SelectionCheckbox id="b" disabled /><a href="/b">Dimmed</a></SelectionPlate>)
  expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
  expect(screen.getByRole('checkbox').title).toBe('Does not match the current filters')
  fireEvent.click(screen.getByRole('link'), { ctrlKey: true })
  expect(plateSelection.has('b')).toBe(false)
  act(() => { plateSelection.select('a'); plateSelection.select('c', { shiftKey: true }) })
  expect(plateSelection.snapshot().map(plate => plate.id)).toEqual(['a', 'c'])
})

it('uses focused input and popover guards even when the keyboard event targets the window', () => {
  plateSelection.add(plates)
  const promote = vi.fn(), close = vi.fn()
  function Harness() { useSelectionKeyboard({ close, promote, disabled: false }); return <><input /><div data-radix-popper-content-wrapper><button>Inside</button></div></> }
  render(<Harness />)
  for (const target of [screen.getByRole('textbox'), screen.getByRole('button')]) {
    target.focus()
    fireEvent.keyDown(window, { key: 'Backspace' })
    fireEvent.keyDown(window, { key: 'Escape' })
  }
  expect(promote).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
  expect(plateSelection.snapshot()).toHaveLength(3)
})

it('Escape cancels an active drag without clearing its selection', () => {
  const template = { ...plateCards[0], templateRole: 'template' as const }
  plateSelection.add([template])
  function Harness() {
    const drag = usePlateDrag({ families: [{ template, variants: [] }], canEdit: true, show: 'all', query: '', edits: { edit: vi.fn(), pending: false }, ordering: { reorder: vi.fn(), pending: false }, targets: () => [], closePreview: vi.fn(), reload: vi.fn() })
    useSelectionKeyboard({ close: vi.fn(), promote: drag.promote, disabled: false, dragging: !!drag.active })
    return <><button onKeyDown={event => drag.onKeyDown({ kind: 'family', plate: template }, event)}>Handle</button><output>{drag.announcement}</output></>
  }
  render(<Harness />)
  fireEvent.keyDown(screen.getByRole('button'), { key: ' ' })
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.getByText('Cancelled')).toBeTruthy()
  expect(plateSelection.snapshot()).toHaveLength(1)
})

it('filter changes remove dimmed selections from the current State and preserve other States', () => {
  const store = createPlateSelection()
  store.register(plates)
  store.add([...plates, { ...plates[0], id: 'NJ.a', state: 'NJ' }])
  store.visible([plates[0], plates[2]])
  expect(store.snapshot().map(plate => plate.id)).toEqual(['a', 'c', 'NJ.a'])
})
