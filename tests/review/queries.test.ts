import { expect, test } from 'vitest'
import { createMemoryStore } from '../../lib/review/memory-store'
import { reviewQueryScenarios } from './query-scenarios'

reviewQueryScenarios(() => createMemoryStore([]))


test('legacy batches read back with a null creator name', async () => {
  const legacy = {
    id: 'legacy', name: 'Legacy batch', createdBy: 'editor', createdAt: '2026-11-15T12:00:00Z',
    state: 'open' as const, revision: 0, baselineVersion: 1, plateIds: ['one'], approval: null,
  }
  const store = createMemoryStore([legacy])
  expect(await store.getBatch('legacy')).toEqual({ ...legacy, createdByName: null, stateOrders: {} })
  expect(await store.list({})).toEqual([{ ...legacy, createdByName: null, stateOrders: {} }])
})

test('memory signals follow creates and successful commits only', async () => {
  const store = createMemoryStore([])
  const batch = { id: 'signal', name: 'Signal', createdBy: 'editor', createdByName: null, createdAt: '', state: 'open' as const, revision: 0, baselineVersion: 1, plateIds: [], stateOrders: {}, approval: null }
  expect(store.signalRevision(batch.id)).toBeNull()
  await store.create(batch)
  expect(store.signalRevision(batch.id)).toBe(0)
  expect(await store.create({ ...batch, revision: 9 })).toBe('exists')
  expect(store.signalRevision(batch.id)).toBe(0)
  await store.commit(batch.id, 0, { batch: { ...batch, revision: 1 } })
  expect(store.signalRevision(batch.id)).toBe(1)
  expect(await store.commit(batch.id, 0, { batch: { ...batch, revision: 2 } })).toBe('revision_mismatch')
  expect(store.signalRevision(batch.id)).toBe(1)
})
