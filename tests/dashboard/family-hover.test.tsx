import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, expect, test, vi } from 'vitest'
import { plateCards } from '../../fixtures/plate-cards'
import {
  expandFamilyPlate,
  projectFamilyPlate,
} from '../../components/dashboard/family-grid/family-data'
const detail = vi.hoisted(() => vi.fn())
vi.mock('../../lib/client/hooks', () => ({
  usePlateDetail: detail,
  /** Provide the plate overlay used to render this catalog scenario. */
  useDraftOverlay: (plates: unknown[]) => plates,
}))
import PlateHoverCard from '../../components/plate/plate-hover-card'
const summary = expandFamilyPlate(projectFamilyPlate(plateCards[0]))
beforeEach(() => detail.mockReset())
test('hover requests the full plate through the shared detail hook', () => {
  detail.mockReturnValue({ data: { plate: plateCards[0] } })
  const html = renderToStaticMarkup(
    <PlateHoverCard plate={summary} left={8} top={8} />
  )
  expect(detail).toHaveBeenCalledWith(summary.id)
  expect(html).toContain(plateCards[0].checks.description.value!)
  expect(html).not.toContain('Loading plate details')
})
test('pending details never masquerade as missing catalog values', () => {
  detail.mockReturnValue({})
  const html = renderToStaticMarkup(
    <PlateHoverCard plate={summary} left={8} top={8} />
  )
  expect(html).toContain('Loading plate details')
  expect(html).not.toContain('No description')
})
test('detail failures leave navigation available and explain the missing preview', () => {
  detail.mockReturnValue({ error: new Error('Unavailable') })
  const html = renderToStaticMarkup(
    <PlateHoverCard plate={summary} left={8} top={8} />
  )
  expect(html).toContain('Unable to load plate details')
  expect(html).toContain('Click to open')
})
