// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { FilterBarControls } from '../components/dashboard/filter-bar'
import { TooltipProvider } from '../components/ui/tooltip'
import {
  filterCounts,
  plateIdsForCheck,
  projectFamilyPlate,
} from '../components/dashboard/family-data'
import { useFamilyBatchOverlay } from '../components/dashboard/family-grid'
import { alaskaFixture } from '../fixtures/dashboard-frame'
import type { PlateCardData } from '../lib/catalog/dashboard-types'

const navigation = vi.hoisted(() => ({ replace: vi.fn(), overlay: vi.fn() }))
vi.mock('../lib/client/hooks', () => ({ useDraftOverlay: navigation.overlay }))
vi.mock('next/navigation', () => ({
  /** Supply the query parameters that define the fixture workspace state. */
  useSearchParams: () => new URLSearchParams('q=gold'),
  /** Supply the current pathname for the navigation state under test. */
  usePathname: () => '/states/AK',
  /** Capture or stub navigation so the test can drive routing without Next.js. */
  useRouter: () => navigation,
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/**
 * Render filter controls from a real draft overlay and its computed needs-work counts.
 */
function Probe({
  onSelectGroup,
}: {
  onSelectGroup(key: string, ids: string[]): void
}) {
  const overlaid = useFamilyBatchOverlay(
    alaskaFixture.plates.map(projectFamilyPlate)
  )
  return (
    <TooltipProvider>
      <FilterBarControls
        counts={filterCounts(overlaid)}
        changedCount={0}
        resolveGroup={(key) => plateIdsForCheck(overlaid, key, 'gold')}
        onSelectGroup={onSelectGroup}
      />
    </TooltipProvider>
  )
}

test('Shift-click resolves the latest draft group intersected with search; plain click filters', () => {
  const onSelectGroup = vi.fn()
  const [first, second, third] = structuredClone(
    alaskaFixture.plates.slice(0, 3)
  )
  first.displayName = 'Gold draft'
  second.displayName = 'Silver draft'
  third.displayName = 'Gold completed draft'
  third.checks.funFacts.status = 'good'
  let overlaid: PlateCardData[] = [first, second, third]
  navigation.overlay.mockImplementation(() => overlaid)
  const view = render(<Probe onSelectGroup={onSelectGroup} />)
  const chip = screen.getByRole('button', { name: /No fun facts/ })
  fireEvent.click(chip, { shiftKey: true })
  expect(onSelectGroup).toHaveBeenLastCalledWith('nofunfacts', [first.id])
  expect(navigation.replace).not.toHaveBeenCalled()
  overlaid = [{ ...second, displayName: 'Gold newly matching draft' }]
  view.rerender(<Probe onSelectGroup={onSelectGroup} />)
  fireEvent.click(chip, { shiftKey: true })
  expect(onSelectGroup).toHaveBeenLastCalledWith('nofunfacts', [second.id])
  fireEvent.click(chip)
  expect(navigation.replace).toHaveBeenCalledWith(
    '/states/AK?q=gold&show=nofunfacts',
    { scroll: false }
  )
  expect(onSelectGroup).toHaveBeenCalledTimes(2)
})

test('Shift-click on an empty group neither resolves nor filters', () => {
  const resolveGroup = vi.fn(),
    onSelectGroup = vi.fn()
  render(
    <TooltipProvider>
      <FilterBarControls
        counts={filterCounts([])}
        changedCount={0}
        resolveGroup={resolveGroup}
        onSelectGroup={onSelectGroup}
      />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: /No description/ }), {
    shiftKey: true,
  })
  expect(resolveGroup).not.toHaveBeenCalled()
  expect(onSelectGroup).not.toHaveBeenCalled()
  expect(navigation.replace).not.toHaveBeenCalled()
})

test('no callback fires when search excludes the entire nonempty group', () => {
  const onSelectGroup = vi.fn()
  render(
    <TooltipProvider>
      <FilterBarControls
        counts={filterCounts(alaskaFixture.plates)}
        changedCount={0}
        resolveGroup={(key) =>
          plateIdsForCheck(alaskaFixture.plates, key, 'no matching record')
        }
        onSelectGroup={onSelectGroup}
      />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: /No fun facts/ }), {
    shiftKey: true,
  })
  expect(onSelectGroup).not.toHaveBeenCalled()
  expect(navigation.replace).not.toHaveBeenCalled()
})
