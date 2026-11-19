// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ReviewWorkspace } from '../components/review/workspace'
import type { BatchDetail } from '../lib/client/hooks'
import { batch, snapshot } from './publish/fixture'

const state = vi.hoisted(() => ({
  detail: undefined as BatchDetail | undefined,
  old: undefined as BatchDetail | undefined,
  extra: [] as BatchDetail[],
  revisions: {} as Record<string, number>,
  mutate: vi.fn().mockResolvedValue(undefined),
  replace: vi.fn(),
  discard: vi.fn().mockResolvedValue(undefined),
  params: new URLSearchParams('batch=fresh'),
}))
vi.mock('next/navigation', () => ({
  useSearchParams: () => state.params,
  useRouter: () => ({ replace: state.replace }),
}))
vi.mock('../lib/client/live-signal', () => ({
  useBatchRevisionSignal: () => 'Live',
}))
vi.mock('../lib/client/review-checkpoint', () => ({
  useReviewCheckpoint: vi.fn(),
  useRecentReviewPlates: () => ({}),
}))
vi.mock('next/image', () => ({ default: () => <span /> }))
vi.mock('../components/review/diff', () => ({
  changeSummary: () => 'Tags',
  DiffTable: ({
    before,
    after,
  }: BatchDetail['plates'][number] & {
    before: { tags: string[] }
    after: { tags: string[] }
  }) => (
    <p>
      Before: {before.tags.join(', ')}; proposed: {after.tags.join(', ')}
    </p>
  ),
}))
vi.mock('../lib/client/hooks', () => ({
  /** Supply the current fixture actor for role and account-dependent behavior. */
  useMe: () => ({ data: { uid: 'owner', role: 'owner' } }),
  /** Supply the workflow phase used by the fixture batch view. */
  useBatchRun: () => ({}),
  /** Provide the batch list for the current workspace scenario. */
  useBatches: (states: string[]) => ({
    data:
      states[0] === 'submitted'
        ? [state.old?.batch].filter(Boolean)
        : state.extra.map(({ batch }) => ({
            ...batch,
            revision: state.revisions[batch.id] ?? batch.revision,
          })),
  }),
  /** Provide batch detail from the fixture in place of an SWR request. */
  useBatch: (id: string | null) => ({
    data:
      id === 'fresh'
        ? state.detail
        : id === 'old'
          ? state.old
          : state.extra.find((detail) => detail.batch.id === id),
    mutate: state.mutate,
    isLoading: id === 'fresh' && !state.detail,
  }),
  /** Provide controllable batch actions so the test can inspect user requests. */
  useReviewActions: () => ({ discardPlateChanges: state.discard }),
  /** Name the shared draft Review lists without a linked Batch. */
  useSharedDraftId: () => 'draft',
}))
afterEach(() => {
  cleanup()
  state.params = new URLSearchParams('batch=fresh')
  state.extra = []
  state.revisions = {}
  state.mutate.mockClear()
  state.discard.mockClear()
})

test('a copied Batch link waits for its detail and opens its own fresh before values despite another pending Batch', async () => {
  state.detail = undefined
  state.replace.mockClear()
  const oldPlate = {
    baseline: snapshot.plates[0],
    proposed: { ...snapshot.plates[0], tags: ['other pending proposal'] },
    edit: null,
    revision: 'old',
  }
  state.old = {
    batch: { ...batch, id: 'old', state: 'submitted' },
    plates: [oldPlate],
  }
  const props = {
    states: [
      {
        code: 'CA',
        name: 'California',
        plates: snapshot.plates.map((plate) => ({ ...plate, imageUrl: null })),
      },
    ],
  }
  const view = render(<ReviewWorkspace {...props} />)
  await waitFor(() =>
    expect(
      screen.getAllByText('Loading review batches…').length
    ).toBeGreaterThan(0)
  )
  expect(state.replace).not.toHaveBeenCalled()
  expect(screen.queryByText(/proposed: other pending proposal/)).toBeNull()
  state.detail = {
    batch: {
      ...batch,
      id: 'fresh',
      state: 'open',
      createdBy: 'owner',
      revision: 0,
      approval: null,
      baselineVersion: 2,
      source: { batchId: batch.id, revision: 2 },
    },
    plates: [
      {
        ...oldPlate,
        baseline: { ...snapshot.plates[0], tags: ['new live value'] },
        proposed: { ...snapshot.plates[0], tags: ['copied proposal'] },
      },
    ],
  }
  view.rerender(<ReviewWorkspace {...props} />)
  expect(
    screen.getByText('Before: new live value; proposed: copied proposal')
  ).toBeTruthy()
  expect(screen.getByText('original Batch revision 2')).toBeTruthy()
  expect(screen.getByRole('link', { name: /· CA/ }).getAttribute('href')).toBe(
    '/review?state=CA&plate=one&batch=fresh'
  )
  expect(state.replace).not.toHaveBeenCalled()
})

test('state-sized Batch review loads more changed Plates and searches the whole Batch', async () => {
  const plates = Array.from({ length: 1000 }, (_, index) => {
    const baseline = {
      ...snapshot.plates[0],
      id: 'CA.' + index,
      displayName: 'Plate ' + index,
    }
    return {
      baseline,
      proposed: { ...baseline, tags: ['accepted'] },
      edit: null,
      revision: 'saved',
    }
  })
  state.detail = {
    batch: {
      ...batch,
      id: 'fresh',
      plateIds: plates.map((plate) => plate.baseline.id),
    },
    plates,
  }
  const view = render(
    <ReviewWorkspace
      states={[{ code: 'CA', name: 'California', plates: [] }]}
    />
  )
  const list = within(screen.getByRole('region', { name: 'Plates' }))
  expect(list.getByText('1000 changed Plates')).toBeTruthy()
  expect(list.getByRole('link', { name: /^Plate 39 / })).toBeTruthy()
  expect(list.queryByRole('link', { name: /^Plate 40 / })).toBeNull()
  fireEvent.click(list.getByRole('button', { name: 'Load more plates' }))
  expect(list.getByRole('link', { name: /^Plate 40 / })).toBeTruthy()
  fireEvent.change(
    list.getByRole('searchbox', { name: 'Search changed plates' }),
    { target: { value: 'Plate 999' } }
  )
  expect(
    list.getByRole('link', { name: /^Plate 999 / }).getAttribute('href')
  ).toBe('/review?state=CA&plate=CA.999&batch=fresh')
  expect(list.queryByRole('link', { name: /^Plate 39 / })).toBeNull()

  state.params = new URLSearchParams('batch=fresh&run=preview')
  view.rerender(<ReviewWorkspace states={[]} />)
  expect(screen.getByText('This run has no saved draft changes')).toBeTruthy()
  expect(
    screen
      .getAllByRole('link', { name: 'Show all Batch changes' })
      .map((link) => link.getAttribute('href'))
  ).toContain('/review?batch=fresh')
  state.params = new URLSearchParams('batch=fresh')
})

test('default Review lists only the shared draft and keeps the list when inspecting a plate', async () => {
  state.params = new URLSearchParams()
  state.replace.mockClear()
  const proposal = (name: string, id: string) => {
    const baseline = { ...snapshot.plates[0], id, displayName: name }
    return {
      baseline,
      proposed: { ...baseline, tags: [name] },
      edit: null,
      revision: 'saved',
    }
  }
  const legacy = {
    batch: {
      ...batch,
      id: 'legacy',
      name: 'Legacy open batch',
      state: 'open' as const,
    },
    plates: [proposal('Legacy change', 'CA.legacy')],
  }
  const draft = {
    batch: {
      ...batch,
      id: 'draft',
      kind: 'shared-draft' as const,
      name: 'Shared draft',
      state: 'open' as const,
    },
    plates: [proposal('Draft change', 'CA.draft')],
  }
  state.old = {
    batch: { ...batch, id: 'old', state: 'submitted' },
    plates: [proposal('Submitted change', 'CA.submitted')],
  }
  state.extra = [legacy, draft]
  const props = {
    states: [
      { code: 'CA', name: 'California', plates: [] },
      { code: 'AK', name: 'Alaska', plates: [] },
    ],
  }
  const view = render(<ReviewWorkspace {...props} />)
  const draftLink = await screen.findByRole('link', {
    name: 'Draft change · CA',
  })
  // Unfolded legacy Batches and submitted Batches are not part of the draft.
  expect(screen.queryByRole('navigation', { name: 'Batches' })).toBeNull()
  expect(screen.queryByRole('link', { name: 'Legacy change · CA' })).toBeNull()
  expect(
    screen.queryByRole('link', { name: 'Submitted change · CA' })
  ).toBeNull()
  expect(state.replace).not.toHaveBeenCalled()
  const states = within(
    screen.getByRole('navigation', { name: 'Review states' })
  )
  expect(
    (states.getByRole('radio', { name: 'Changed' }) as HTMLInputElement).checked
  ).toBe(true)
  expect(states.queryByRole('link', { name: /Alaska/ })).toBeNull()
  fireEvent.click(states.getByRole('radio', { name: 'All states' }))
  expect(states.getByRole('link', { name: /Alaska/ })).toBeTruthy()
  fireEvent.click(states.getByRole('radio', { name: 'Changed' }))
  expect(states.queryByRole('link', { name: /Alaska/ })).toBeNull()
  expect(states.getByRole('link', { name: /California/ })).toBeTruthy()
  fireEvent.click(states.getByRole('radio', { name: 'All states' }))
  expect(states.getByRole('link', { name: /Alaska/ })).toBeTruthy()
  expect(draftLink.getAttribute('href')).toBe(
    '/review?plate=CA.draft&focusBatch=draft'
  )
  state.params = new URLSearchParams(
    draftLink.getAttribute('href')!.split('?')[1]
  )
  view.rerender(<ReviewWorkspace {...props} />)
  expect(screen.getByText(/proposed: Draft change/)).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Draft change · CA' })).toBeTruthy()
  state.revisions.draft = draft.batch.revision + 1
  view.rerender(<ReviewWorkspace {...props} />)
  expect(state.mutate).toHaveBeenCalledOnce()
  state.extra = [
    legacy,
    {
      ...draft,
      batch: { ...draft.batch, revision: state.revisions.draft },
      plates: [...draft.plates, proposal('Later pipeline change', 'CA.later')],
    },
  ]
  view.rerender(<ReviewWorkspace {...props} />)
  expect(
    await screen.findByRole('link', { name: 'Later pipeline change · CA' })
  ).toBeTruthy()
})

test('All review changes keeps one row per plate and scopes removal to the shared draft', async () => {
  state.params = new URLSearchParams()
  const baseline = {
    ...snapshot.plates[0],
    id: 'CA.one',
    displayName: 'Shared plate',
    tags: ['catalog'],
  }
  const latest: BatchDetail = {
    batch: {
      ...batch,
      id: 'draft',
      kind: 'shared-draft',
      name: 'Shared draft',
      state: 'open',
      revision: 7,
      lastChangedAt: '2026-11-18T10:00:00Z',
    },
    plates: [
      {
        baseline,
        proposed: { ...baseline, templateFamily: 'CA.group', tags: ['latest'] },
        edit: null,
        revision: 'latest',
        order: { before: 1, after: 0, total: 2 },
      },
    ],
  }
  state.extra = [latest]
  const props = { states: [{ code: 'CA', name: 'California', plates: [] }] }
  const view = render(<ReviewWorkspace {...props} />)
  const list = within(screen.getByRole('region', { name: 'Plates' }))
  const row = await list.findByRole('link', { name: 'Shared plate · CA' })
  expect(list.getAllByRole('link', { name: 'Shared plate · CA' })).toHaveLength(
    1
  )
  expect(row.getAttribute('href')).toBe('/review?plate=CA.one&focusBatch=draft')
  expect(
    within(row).getAllByRole('img', { name: 'Tags changed' })
  ).toHaveLength(1)
  expect(within(row).getByRole('img', { name: 'Family changed' })).toBeTruthy()
  expect(within(row).getByRole('img', { name: 'Order changed' })).toBeTruthy()
  expect(list.getByText('1 changed Plate')).toBeTruthy()
  expect(
    within(screen.getByRole('navigation', { name: 'Review states' })).getByRole(
      'link',
      { name: 'All changes 1' }
    )
  ).toBeTruthy()

  fireEvent.change(
    list.getByRole('searchbox', { name: 'Search changed plates' }),
    { target: { value: 'shared plate' } }
  )
  expect(list.getByRole('link', { name: 'Shared plate · CA' })).toBe(row)
  const detail = within(
    screen.getByRole('region', { name: 'Before and after' })
  )
  expect(detail.getAllByRole('heading', { name: 'Shared plate' })).toHaveLength(
    1
  )
  const changes = within(
    detail.getByRole('region', { name: 'Changes in Shared draft' })
  )
  expect(changes.getByText('Before: catalog; proposed: latest')).toBeTruthy()

  const updated = {
    ...latest,
    batch: { ...latest.batch, revision: 8 },
    plates: latest.plates.map((plate) => ({
      ...plate,
      proposed: { ...plate.proposed, tags: ['updated'] },
    })),
  }
  state.extra = [updated]
  view.rerender(<ReviewWorkspace {...props} />)
  expect(
    await changes.findByText('Before: catalog; proposed: updated')
  ).toBeTruthy()
  expect(list.getByRole('link', { name: 'Shared plate · CA' })).toBe(row)

  fireEvent.click(changes.getByRole('button', { name: 'Remove all changes' }))
  const dialog = within(
    await screen.findByRole('alertdialog', {
      name: 'Remove all changes for Shared plate?',
    })
  )
  fireEvent.click(dialog.getByRole('button', { name: 'Remove all changes' }))
  await waitFor(() =>
    expect(state.discard).toHaveBeenCalledExactlyOnceWith(
      'draft',
      'CA.one',
      8,
      'all'
    )
  )

  state.params = new URLSearchParams('plate=CA.one&focusBatch=draft')
  state.extra = [{ ...updated, plates: [] }]
  view.rerender(<ReviewWorkspace {...props} />)
  await waitFor(() =>
    expect(
      detail.queryByRole('region', { name: 'Changes in Shared draft' })
    ).toBeNull()
  )
  expect(list.queryByRole('link', { name: 'Shared plate · CA' })).toBeNull()
})
