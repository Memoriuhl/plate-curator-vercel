import type { PlateCardData } from '../lib/catalog/dashboard-types'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { plateCards } from '../fixtures/plate-cards'
import { projectFamilyPlate } from '../components/dashboard/family-data'
const overlay = vi.hoisted(() => vi.fn())
vi.mock('../lib/client/hooks', () => ({ useDraftOverlay: overlay }))
import { useFamilyBatchOverlay } from '../components/dashboard/family-grid'
/**
 * Expose the overlaid plate's active change marker so the test can observe batch
 * updates.
 */
function Probe() {
  const plates = useFamilyBatchOverlay([projectFamilyPlate(plateCards[0])])
  return <p>{String(plates[0]?.changedInBatch)}</p>
}
test('grid delegates to the shared overlay with client-only null check values', () => {
  overlay.mockImplementation((plates: PlateCardData[]) =>
    plates.map((plate) => ({ ...plate, changedInBatch: true }))
  )
  expect(renderToStaticMarkup(<Probe />)).toContain('true')
  const input = overlay.mock.calls[0][0][0]
  expect(input.id).toBe(plateCards[0].id)
  expect(input.checks.description.value).toBeNull()
  expect(input.checks.description.status).toBe(
    plateCards[0].checks.description.status
  )
})
