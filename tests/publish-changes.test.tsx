// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { BatchChanges, changesByState } from '../components/publish/batch-changes'
import { PublishWorkspace } from '../components/publish/workspace'
import type { BatchDetail } from '../lib/client/hooks'

const status = vi.hoisted(() => ({ value: 'published' }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); status.value = 'published' })
const baseline = { id: 'AK.one', state: 'AK', slug: 'one', displayName: 'One', image: 'one.webp', tags: [] }
const entry = { baseline, proposed: { ...baseline, description: 'New' }, edit: null, revision: 'r', beforeImageUrl: '/one.webp', order: { before: 0, after: 1, total: 2 } }
const batch = { baselineVersion: 1, revision: 2, stateOrders: {} } as BatchDetail['batch']

test('groups unique changed plates by state with all applicable tags', () => {
  const groups = changesByState([entry, { ...entry, baseline: { ...baseline, id: 'KS.one', state: 'KS' } }])
  expect(groups.map(group => group.code)).toEqual(['AK', 'KS'])
  expect(groups[0].plates).toHaveLength(1)
  expect(groups[0].plates[0].tags).toEqual(['Edited', 'Reordered'])
  expect(changesByState([{ ...entry, proposed: baseline, order: undefined }])).toEqual([])
})

test('state and plate chevrons expand on demand with lazy thumbnails', () => {
  const view = render(<BatchChanges plates={[entry]} batch={batch} />)
  expect(screen.queryByRole('button', { name: /One/ })).toBeNull()
  expect(view.container.querySelector('img')?.getAttribute('loading')).toBe('lazy')
  fireEvent.click(screen.getByRole('button', { name: /AK Alaska/ }))
  const row = screen.getByRole('button', { name: /One/ })
  expect(row.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText(/Before.*Catalog/)).toBeNull()
  fireEvent.click(row)
  expect(screen.getByText(/Before.*Catalog v1/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /AK Alaska/ }))
  expect(screen.queryByText(/Before.*Catalog/)).toBeNull()
})

vi.mock('../lib/client/hooks', () => ({
  useMe: () => ({ data: { role: 'owner' } }),
  usePublishControl: () => ({ data: { control: null }, change: vi.fn() }),
  useBatches: () => ({ data: [{ id: 'published', name: 'Autumn plates', state: status.value, createdAt: '2026-11-17', revision: 2, stateOrders: {} }] }),
  useBatch: () => ({ data: { batch: { id: 'published', name: 'Autumn plates', state: status.value, revision: 2, stateOrders: {} }, plates: [] } }),
  useBatchRun: () => ({ data: { outcome: { version: 16 } } }),
  usePublishBaseline: () => ({ data: {} }),
  useReviewActions: () => ({}),
}))

test('published batch uses the catalog version as its visual anchor', () => {
  render(<PublishWorkspace />)
  const card = screen.getByRole('button', { name: /v16.*Autumn plates/ })
  expect(card.querySelector('.text-4xl')?.textContent).toBe('v16')
  expect(card.textContent).not.toContain('waiting')
})

test('large state groups mount only a window of plate rows', () => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(88)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(560)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
  const plates = Array.from({ length: 250 }, (_, index) => ({ ...entry, baseline: { ...baseline, id: `AK.${index}` }, proposed: { ...entry.proposed, id: `AK.${index}`, displayName: `Plate ${index}` } }))
  render(<BatchChanges plates={plates} batch={batch} />)
  fireEvent.click(screen.getByRole('button', { name: /AK Alaska/ }))
  const rows = screen.getAllByRole('button', { name: /Plate / })
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.length).toBeLessThan(30)
})

test('missing approval remains a visible blocking message', () => {
  status.value = 'approved'
  render(<PublishWorkspace />)
  expect(screen.getByRole('alert').textContent).toContain('needs current approval')
  expect(screen.queryByRole('button', { name: /Publish revision/ })).toBeNull()
})

