// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { FamilyGrid } from '../components/dashboard/family-grid'
import { plateSelection } from '../components/dashboard/plate-selection'
import { projectFamilyPlate } from '../components/dashboard/family-data'
import { TooltipProvider } from '../components/ui/tooltip'
import { alaskaFixture } from '../fixtures/dashboard-frame'

const data = vi.hoisted(() => ({ overlay: vi.fn(), replace: vi.fn() }))
vi.mock('../lib/client/hooks', () => ({
  useDraftOverlay: data.overlay,
  /** Supply the selected batch and its editability for this workspace scenario. */
  useWorkspaceBatch: () => ({ mode: 'personal' }),
  /** Provide the batch list for the current workspace scenario. */
  useBatches: () => ({ data: [] }),
  /** Supply the current fixture actor for role and account-dependent behavior. */
  useMe: () => ({ data: { role: 'editor' } }),
  /** Expose the fixture edit callback so tests can inspect submitted plate changes. */
  useEditPlate: () => ({ edit: vi.fn(), pending: false }),
  /**
   * Provide a harmless reorder stub so filter selection tests can run the family grid.
   */
  useReorderState: () => ({ reorder: vi.fn(), pending: false }),
  /** Disable detail prefetch requests while exercising needs-work selection. */
  usePreloadPlateDetail: () => vi.fn(),
}))
vi.mock('../lib/client/session', () => ({ /** Supply the fixture session and API client to the component under test. */ useSession: () => ({ user: null }) }))
vi.mock('next/navigation', () => ({
  /** Supply the query parameters that define the fixture workspace state. */
  useSearchParams: () => new URLSearchParams('q=gold'),
  /** Supply the current pathname for the navigation state under test. */
  usePathname: () => '/states/AK',
  /** Capture or stub navigation so the test can drive routing without Next.js. */
  useRouter: () => ({ replace: data.replace }),
}))
vi.mock('../components/dashboard/use-drag-flip', () => ({ useDragFlip: vi.fn() }))
vi.mock('../components/dashboard/use-grid-entrance', () => ({ useGridEntrance: vi.fn() }))
vi.mock('@tanstack/react-virtual', () => ({ /** Render predictable virtual rows without depending on a real browser viewport. */ useWindowVirtualizer: () => ({
  /** Expose the deterministic virtual rows used by the test layout. */
  getVirtualItems: () => [], /** Report the virtual list size expected by the layout fixture. */ getTotalSize: () => 0, measureElement: vi.fn(), scrollToIndex: vi.fn(),
}) }))
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { /** Satisfy observer registration in the test DOM without starting a browser observer. */ observe() {} /** Satisfy observer cleanup in the test DOM without installing a browser observer. */ disconnect() {} })
})
afterEach(() => { cleanup(); plateSelection.clear(); vi.clearAllMocks(); vi.unstubAllGlobals() })

test('Shift-click selects exactly the chip ids resolved from the current overlay and query', () => {
  const [first, second, third] = structuredClone(alaskaFixture.plates.slice(0, 3))
  first.displayName = 'Gold draft'
  first.checks.funFacts.status = 'missing'
  second.displayName = 'Silver draft'
  second.checks.funFacts.status = 'missing'
  third.displayName = 'Gold completed draft'
  third.checks.funFacts.status = 'good'
  let overlaid = [first, second, third]
  data.overlay.mockImplementation(() => overlaid)
  const onSelectGroup = vi.fn()
  const plates = alaskaFixture.plates.map(projectFamilyPlate)
  const view = render(<TooltipProvider><FamilyGrid code="AK" plates={plates} onSelectGroup={onSelectGroup} /></TooltipProvider>)
  const grid = screen.getByRole('region', { name: 'Plate families' })
  const spacing = grid.className
  expect(spacing).toContain('pb-56')
  fireEvent.click(screen.getByRole('button', { name: /No fun facts/ }), { shiftKey: true })
  expect(grid.className).toBe(spacing)
  expect(plateSelection.snapshot().map(plate => plate.id)).toEqual([first.id])
  expect(onSelectGroup).toHaveBeenLastCalledWith('nofunfacts', [first.id])
  expect(data.replace).not.toHaveBeenCalled()

  overlaid = [first, { ...second, displayName: 'Gold newly matching draft' }, third]
  view.rerender(<TooltipProvider><FamilyGrid code="AK" plates={plates} onSelectGroup={onSelectGroup} /></TooltipProvider>)
  fireEvent.click(screen.getByRole('button', { name: /No fun facts/ }), { shiftKey: true })
  expect(plateSelection.snapshot().map(plate => plate.id)).toEqual([first.id, second.id])
  expect(onSelectGroup).toHaveBeenLastCalledWith('nofunfacts', [first.id, second.id])
  expect(plateSelection.has(third.id)).toBe(false)
})
