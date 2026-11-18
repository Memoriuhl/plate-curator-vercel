import { expect, test } from 'vitest'
import { createMemoryStore } from '../../lib/review/memory-store'
import { dashboardDrafts } from '../../lib/review/queries'
import type { ReviewBatch, ReviewDeps } from '../../lib/review/types'
import { reviewQueryScenarios } from './query-scenarios'

reviewQueryScenarios(() => createMemoryStore([]))

test('dashboard reads saved orders and sparse edits from the signed-in curator’s pending Batches', async () => {
  const actor = { uid: 'editor', name: null, role: 'editor' } as const
  const plate = {
    id: 'AK.one',
    state: 'AK',
    slug: 'one',
    displayName: 'One',
    tags: [],
    image: '',
  }
  const batch: ReviewBatch = {
    id: 'first',
    name: 'First',
    createdBy: actor.uid,
    createdByName: null,
    createdAt: '2026-11-18',
    state: 'approved',
    revision: 1,
    baselineVersion: 1,
    plateIds: [plate.id],
    stateOrders: { AK: ['AK.two', plate.id], AL: ['AL.one'] },
    approval: null,
  }
  const store = createMemoryStore([
    batch,
    { ...batch, id: 'published', state: 'published' },
    { ...batch, id: 'other', createdBy: 'other' },
    { ...batch, id: 'unrelated', plateIds: ['AL.one'], stateOrders: {} },
  ])
  const baselineAtVersion = async (_version: number, id: string) =>
    id === plate.id ? plate : null
  const deps: ReviewDeps = {
    store,
    baselineAtVersion,
    baseline: (id) => baselineAtVersion(1, id),
    stateBaseline: async () => [plate],
    now: () => '2026-11-18',
  }
  await store.commit(batch.id, batch.revision, {
    batch: { ...batch, revision: 2 },
    edit: {
      plateId: plate.id,
      baseRevision: 'base',
      fields: { tags: ['saved'] },
      authorId: actor.uid,
      updatedAt: deps.now(),
      resultRevision: 'saved',
    },
  })

  expect(await dashboardDrafts(deps, actor, new Set(['AK']))).toEqual([
    {
      batch: {
        ...batch,
        revision: 2,
        stateOrders: { AK: ['AK.two', plate.id] },
      },
      plates: [
        expect.objectContaining({
          baseline: plate,
          proposed: { ...plate, tags: ['saved'] },
          revision: 'saved',
        }),
      ],
    },
  ])
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
