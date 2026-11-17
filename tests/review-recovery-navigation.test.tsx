// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ReviewWorkspace } from '../components/review/workspace'
import type { BatchDetail } from '../lib/client/hooks'
import { batch, snapshot } from './publish/fixture'

const state = vi.hoisted(() => ({ detail: undefined as BatchDetail | undefined, old: undefined as BatchDetail | undefined, replace: vi.fn(), params: new URLSearchParams('batch=fresh') }))
vi.mock('next/navigation', () => ({ useSearchParams: () => state.params, useRouter: () => ({ replace: state.replace }) }))
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
  // The unrelated Batch loads first; its auto-navigation must not replace the recovery link.
  await waitFor(() => expect(screen.getAllByText(/Tags/).length).toBeGreaterThan(0))
  expect(state.replace).not.toHaveBeenCalled()
  expect(screen.queryByText(/proposed: other pending proposal/)).toBeNull()
  state.detail = { batch: { ...batch, id: 'fresh', state: 'open', createdBy: 'owner', revision: 0, approval: null, baselineVersion: 2, source: { batchId: batch.id, revision: 2 } }, plates: [{ ...oldPlate, baseline: { ...snapshot.plates[0], tags: ['new live value'] }, proposed: { ...snapshot.plates[0], tags: ['copied proposal'] } }] }
  view.rerender(<ReviewWorkspace {...props} />)
  expect(screen.getByText('Before: new live value; proposed: copied proposal')).toBeTruthy()
  expect(screen.getByText('original Batch revision 2')).toBeTruthy()
  await waitFor(() => expect(state.replace).toHaveBeenCalledWith('/review?state=CA&plate=one&batch=fresh'))
})
