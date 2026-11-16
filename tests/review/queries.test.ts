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
  expect(await store.getBatch('legacy')).toEqual({ ...legacy, createdByName: null })
  expect(await store.list({})).toEqual([{ ...legacy, createdByName: null }])
})
