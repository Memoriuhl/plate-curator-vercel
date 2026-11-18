// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ReviewWorkspace } from '../components/review/workspace'
import type { BatchDetail } from '../lib/client/hooks'
import { batch, snapshot } from './publish/fixture'

const state = vi.hoisted(() => ({ detail: undefined as BatchDetail | undefined, old: undefined as BatchDetail | undefined, replace: vi.fn(), params: new URLSearchParams('batch=fresh') }))
vi.mock('next/navigation', () => ({ useSearchParams: () => state.params, useRouter: () => ({ replace: state.replace }) }))
vi.mock('../lib/client/live-signal', () => ({ useBatchRevisionSignal: () => 'Live' }))
vi.mock('../lib/client/review-checkpoint', () => ({ useReviewCheckpoint: vi.fn(), useRecentReviewPlates: () => ({}) }))
vi.mock('next/image', () => ({ default: () => <span /> }))
vi.mock('../components/review/diff', () => ({ changeSummary: () => 'Tags', DiffTable: ({ before, after }: BatchDetail['plates'][number] & { before: { tags: string[] }; after: { tags: string[] } }) => <p>Before: {before.tags.join(', ')}; proposed: {after.tags.join(', ')}</p> }))
vi.mock('../lib/client/hooks', () => ({
  useMe: () => ({ data: { uid: 'owner', role: 'owner' } }),
  useBatchRun: () => ({}),
  useBatches: (states: string[]) => ({ data: states[0] === 'submitted' ? [state.old!.batch] : [] }),
  useBatch: (id: string | null) => ({ data: id === 'fresh' ? state.detail : id === 'old' ? state.old : undefined, isLoading: id === 'fresh' && !state.detail }),
  useReviewActions: () => ({}),
}))
afterEach(cleanup)

test('a copied Batch link waits for its detail and opens its own fresh before values despite another pending Batch', async () => {
  state.detail = undefined
  state.replace.mockClear()
  const oldPlate = { baseline: snapshot.plates[0], proposed: { ...snapshot.plates[0], tags: ['other pending proposal'] }, edit: null, revision: 'old' }
  state.old = { batch: { ...batch, id: 'old', state: 'submitted' }, plates: [oldPlate] }
  const props = { states: [{ code: 'CA', name: 'California', plates: snapshot.plates.map(plate => ({ ...plate, imageUrl: null })) }] }
  const view = render(<ReviewWorkspace {...props} />)
  await waitFor(() => expect(screen.getAllByText('Loading review batches…').length).toBeGreaterThan(0))
  expect(state.replace).not.toHaveBeenCalled()
  expect(screen.queryByText(/proposed: other pending proposal/)).toBeNull()
  state.detail = { batch: { ...batch, id: 'fresh', state: 'open', createdBy: 'owner', revision: 0, approval: null, baselineVersion: 2, source: { batchId: batch.id, revision: 2 } }, plates: [{ ...oldPlate, baseline: { ...snapshot.plates[0], tags: ['new live value'] }, proposed: { ...snapshot.plates[0], tags: ['copied proposal'] } }] }
  view.rerender(<ReviewWorkspace {...props} />)
  expect(screen.getByText('Before: new live value; proposed: copied proposal')).toBeTruthy()
  expect(screen.getByText('original Batch revision 2')).toBeTruthy()
  expect(screen.getByRole('link', { name: /· CA/ }).getAttribute('href')).toBe('/review?state=CA&plate=one&batch=fresh')
  expect(state.replace).not.toHaveBeenCalled()
})

test('state-sized Batch review loads more changed Plates and searches the whole Batch', async () => {
  const plates = Array.from({ length: 1000 }, (_, index) => {
    const baseline = { ...snapshot.plates[0], id: 'CA.' + index, displayName: 'Plate ' + index }
    return { baseline, proposed: { ...baseline, tags: ['accepted'] }, edit: null, revision: 'saved' }
  })
  state.detail = { batch: { ...batch, id: 'fresh', plateIds: plates.map(plate => plate.baseline.id) }, plates }
  const view = render(<ReviewWorkspace states={[{ code: 'CA', name: 'California', plates: [] }]} />)
  const list = within(screen.getByRole('region', { name: 'Plates' }))
  expect(list.getByText('1000 changed Plates')).toBeTruthy()
  expect(list.getByRole('link', { name: /^Plate 39 / })).toBeTruthy()
  expect(list.queryByRole('link', { name: /^Plate 40 / })).toBeNull()
  fireEvent.click(list.getByRole('button', { name: 'Load more plates' }))
  expect(list.getByRole('link', { name: /^Plate 40 / })).toBeTruthy()
  fireEvent.change(list.getByRole('searchbox', { name: 'Search changed plates' }), { target: { value: 'Plate 999' } })
  expect(list.getByRole('link', { name: /^Plate 999 / }).getAttribute('href')).toBe('/review?state=CA&plate=CA.999&batch=fresh')
  expect(list.queryByRole('link', { name: /^Plate 39 / })).toBeNull()

  state.params = new URLSearchParams('batch=fresh&run=preview')
  view.rerender(<ReviewWorkspace states={[]} />)
  expect(screen.getByText('This run has no saved draft changes')).toBeTruthy()
  expect(screen.getAllByRole('link', { name: 'Show all Batch changes' }).map(link => link.getAttribute('href'))).toContain('/review?batch=fresh')
  state.params = new URLSearchParams('batch=fresh')
})
