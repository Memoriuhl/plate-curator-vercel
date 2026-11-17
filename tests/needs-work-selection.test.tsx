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
  useWorkspaceBatch: () => ({ mode: 'personal' }),
  useBatches: () => ({ data: [] }),
  useMe: () => ({ data: { role: 'editor' } }),
  useEditPlate: () => ({ edit: vi.fn(), pending: false }),
  useReorderState: () => ({ reorder: vi.fn(), pending: false }),
  usePreloadPlateDetail: () => vi.fn(),
}))
vi.mock('../lib/client/session', () => ({ useSession: () => ({ user: null }) }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('q=gold'),
  usePathname: () => '/states/AK',
  useRouter: () => ({ replace: data.replace }),
}))
vi.mock('../components/dashboard/use-drag-flip', () => ({ useDragFlip: vi.fn() }))
vi.mock('../components/dashboard/use-grid-entrance', () => ({ useGridEntrance: vi.fn() }))
vi.mock('@tanstack/react-virtual', () => ({ useWindowVirtualizer: () => ({
  getVirtualItems: () => [], getTotalSize: () => 0, measureElement: vi.fn(), scrollToIndex: vi.fn(),
}) }))
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
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
  fireEvent.click(screen.getByRole('button', { name: /No fun facts/ }), { shiftKey: true })
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
