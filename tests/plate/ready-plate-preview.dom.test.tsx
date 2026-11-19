import { render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { plateCards } from '../../fixtures/plate-cards'
import type { PlateCardData } from '../../lib/catalog/dashboard-types'

const hooks = vi.hoisted(() => ({ detailIds: [] as (string | null)[] }))
vi.mock('../../lib/client/hooks', () => ({
  usePlateDetail: (id: string | null) => {
    hooks.detailIds.push(id)
    return { data: undefined }
  },
  useDraftOverlay: () => [undefined],
}))
vi.mock('../../components/plate/plate-image-preview', () => ({
  useLatestEnhancement: () => undefined,
  PlateEnhancementPreview: ({ children }: { children: unknown }) => children,
}))

const { ReadyPlatePreview } =
  await import('../../components/plate/ready-plate-preview')

beforeEach(() => {
  // The tooltip measures itself to stay in the viewport; jsdom has no layout.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

test('a run result preview shows the run values without loading the saved plate', () => {
  const card: PlateCardData = {
    ...plateCards[0],
    checks: {
      ...plateCards[0].checks,
      description: { status: 'good', value: 'Written by the run.' },
    },
  }
  const anchor = document.createElement('span')
  document.body.append(anchor)
  render(
    <ReadyPlatePreview
      plate={card}
      anchor={anchor}
      immediate
      checkKey="description"
      localOnly
    />
  )
  expect(screen.getByRole('tooltip').textContent).toContain(
    'Written by the run.'
  )
  expect(hooks.detailIds.every((id) => id === null)).toBe(true)
})
