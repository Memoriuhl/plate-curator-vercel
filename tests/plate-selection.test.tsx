// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FilterBarControls } from '@/components/dashboard/filter-bar'
import { SelectionBar } from '@/components/dashboard/selection-bar'
import { usePlateDrag } from '@/components/dashboard/use-plate-drag'
import { JurisdictionCard } from '@/components/dashboard/jurisdiction-card'
import { plateCards } from '../fixtures/plate-cards'
import { Profiler } from 'react'
import { afterEach, vi, describe, it, expect } from 'vitest'
import { createPlateSelection, plateSelection, SelectionPlate, useSelectionKeyboard } from '@/components/dashboard/plate-selection'
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
  render(<><Profiler id="a" onRender={renderA}><SelectionPlate id="a"><a href="/a">Open A</a></SelectionPlate></Profiler><Profiler id="b" onRender={renderB}><SelectionPlate id="b">B</SelectionPlate></Profiler></>)
  renderA.mockClear(); renderB.mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'Select a' }))
  expect(screen.getByRole('button', { name: 'Select a' }).getAttribute('aria-pressed')).toBe('true')
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
  plateSelection.add([template, variant])
  function Harness() {
    const drag = usePlateDrag({ families: [{ template, variants: [variant] }], canEdit: true, show: 'all', query: '', edits: { edit, pending: false }, ordering: { reorder: vi.fn(), pending: false }, targets: () => [], closePreview: vi.fn(), reload: vi.fn() })
    useSelectionKeyboard({ close: vi.fn(), promote: drag.promote, disabled: false })
    return <><textarea aria-label="Notes" /><p>{drag.announcement}</p></>
  }
  render(<Harness />)
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Backspace' })
  expect(edit).not.toHaveBeenCalled()
  await act(async () => fireEvent.keyDown(window, { key: 'Backspace' }))
  expect(edit).toHaveBeenCalledExactlyOnceWith(variant, { templateRole: 'template', templateFamily: variant.id, variantOfPlateId: null })
  expect(screen.getByText('1 plates are now Templates')).toBeTruthy()
})

it('Shift-clicking a needs-work chip adds its matching plate ids', () => {
  const matching = { ...plateCards[0], id: 'NY.weak', checks: { ...plateCards[0].checks, tags: { status: 'weak' as const, value: null } } }
  plateSelection.register([matching])
  const select = vi.fn()
  render(<FilterBarControls counts={{ all: 1, undertagged: 1, generic: 0, nofunfacts: 0 }} changedCount={0} onSelectGroup={select} />)
  fireEvent.click(screen.getByRole('button', { name: /Under-tagged/ }), { shiftKey: true })
  expect(select).toHaveBeenCalledWith('undertagged', [matching.id])
})
