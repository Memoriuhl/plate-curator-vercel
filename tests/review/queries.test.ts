import { expect, test } from 'vitest'
import { createMemoryStore } from '../../lib/review/memory-store'
import { dashboardDrafts } from '../../lib/review/queries'
import type { ReviewBatch, ReviewDeps } from '../../lib/review/types'
import { reviewQueryScenarios } from './query-scenarios'

reviewQueryScenarios(() => createMemoryStore([]))

test('dashboard reads saved orders and every curator’s edits from the shared draft', async () => {
  const plate = {
    id: 'AK.one',
    state: 'AK',
    slug: 'one',
    displayName: 'One',
    tags: [],
    image: '',
  }
  const other = { ...plate, id: 'AK.two', slug: 'two', displayName: 'Two' }
  const draft: ReviewBatch = {
    id: 'shared-draft-local',
    kind: 'shared-draft',
    name: 'Shared draft',
    createdBy: 'system',
    createdByName: null,
    createdAt: '2026-11-18',
    state: 'open',
    revision: 1,
    baselineVersion: 1,
    plateIds: [plate.id, other.id],
    stateOrders: { AK: ['AK.two', plate.id], AL: ['AL.one'] },
    approval: null,
  }
  const store = createMemoryStore([
    draft,
    {
      ...draft,
      id: 'old-batch',
      kind: undefined,
      createdBy: 'editor',
      plateIds: ['AK.one'],
    },
  ])
  const baselineAtVersion = async (_version: number, id: string) =>
    [plate, other].find((entry) => entry.id === id) ?? null
  const deps: ReviewDeps = {
    store,
    baselineAtVersion,
    baseline: (id) => baselineAtVersion(1, id),
    stateBaseline: async () => [plate, other],
    now: () => '2026-11-18',
  }
  await store.commit(draft.id, 1, {
    batch: { ...draft, revision: 2 },
    edit: {
      plateId: plate.id,
      baseRevision: 'base',
      fields: { tags: ['saved'] },
      authorId: 'editor',
      updatedAt: deps.now(),
      resultRevision: 'saved',
    },
  })
  await store.commit(draft.id, 2, {
    batch: { ...draft, revision: 3 },
    edit: {
      plateId: other.id,
      baseRevision: 'base',
      fields: { tags: ['second'] },
      authorId: 'second-editor',
      updatedAt: deps.now(),
      resultRevision: 'second',
    },
  })

  expect(await dashboardDrafts(deps, draft.id, new Set(['AK']))).toEqual([
    {
      batch: {
        ...draft,
        revision: 3,
        plateEditVersions: { [plate.id]: 2, [other.id]: 3 },
        stateOrders: { AK: ['AK.two', plate.id] },
      },
      plates: [
        expect.objectContaining({
          baseline: plate,
          proposed: { ...plate, tags: ['saved'] },
          revision: 'saved',
        }),
        expect.objectContaining({
          baseline: other,
          proposed: { ...other, tags: ['second'] },
          revision: 'second',
        }),
      ],
    },
  ])
  expect(await dashboardDrafts(deps, draft.id, new Set(['CA']))).toEqual([])
})

test('legacy batches read back with a null creator name', async () => {
  const legacy = {
    id: 'legacy',
    name: 'Legacy batch',
    createdBy: 'editor',
    createdAt: '2026-11-15T12:00:00Z',
    state: 'open' as const,
    revision: 0,
    baselineVersion: 1,
    plateIds: ['one'],
    approval: null,
  }
  const store = createMemoryStore([legacy])
  expect(await store.getBatch('legacy')).toEqual({
    ...legacy,
    createdByName: null,
    stateOrders: {},
  })
  expect(await store.list({})).toEqual([
    { ...legacy, createdByName: null, stateOrders: {} },
  ])
})

test('memory signals follow creates and successful commits only', async () => {
  const store = createMemoryStore([])
  const batch = {
    id: 'signal',
    name: 'Signal',
    createdBy: 'editor',
    createdByName: null,
    createdAt: '',
    state: 'open' as const,
    revision: 0,
    baselineVersion: 1,
    plateIds: [],
    stateOrders: {},
    approval: null,
  }
  expect(store.signalRevision(batch.id)).toBeNull()
  await store.create(batch)
  expect(store.signalRevision(batch.id)).toBe(0)
  expect(await store.create({ ...batch, revision: 9 })).toBe('exists')
  expect(store.signalRevision(batch.id)).toBe(0)
  await store.commit(batch.id, 0, { batch: { ...batch, revision: 1 } })
  expect(store.signalRevision(batch.id)).toBe(1)
  expect(
    await store.commit(batch.id, 0, { batch: { ...batch, revision: 2 } })
  ).toBe('revision_mismatch')
  expect(store.signalRevision(batch.id)).toBe(1)
})
