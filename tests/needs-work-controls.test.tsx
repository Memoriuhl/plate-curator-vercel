// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { FilterBarControls } from '../components/dashboard/filter-bar'
import { TooltipProvider } from '../components/ui/tooltip'
import { filterCounts, plateIdsForCheck } from '../components/dashboard/family-data'
import { alaskaFixture } from '../fixtures/dashboard-frame'

const navigation = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('q=gold'),
  usePathname: () => '/states/AK',
  useRouter: () => navigation,
}))
afterEach(() => { cleanup(); vi.clearAllMocks() })

test('Shift-click emits precisely the chip group without changing the URL; plain click filters', () => {
  const onSelectGroup = vi.fn()
  render(<TooltipProvider><FilterBarControls counts={filterCounts(alaskaFixture.plates)} changedCount={0} onSelectGroup={onSelectGroup} /></TooltipProvider>)
  const chip = screen.getByRole('button', { name: /No fun facts/ })
  fireEvent.click(chip, { shiftKey: true })
  expect(onSelectGroup).toHaveBeenCalledWith('nofunfacts', plateIdsForCheck(alaskaFixture.plates, 'nofunfacts'))
  expect(navigation.replace).not.toHaveBeenCalled()
  fireEvent.click(chip)
  expect(navigation.replace).toHaveBeenCalledWith('/states/AK?q=gold&show=nofunfacts', { scroll: false })
  expect(onSelectGroup).toHaveBeenCalledTimes(1)
})

test('without a selection callback Shift-click still filters', () => {
  render(<TooltipProvider><FilterBarControls counts={filterCounts([])} changedCount={0} /></TooltipProvider>)
  fireEvent.click(screen.getByRole('button', { name: /No description/ }), { shiftKey: true })
  expect(navigation.replace).toHaveBeenCalledWith('/states/AK?q=gold&show=missingDescription', { scroll: false })
})
