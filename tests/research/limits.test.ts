import { expect, test } from 'vitest'
import { createResearchMemoryState } from '../../lib/research/state'
import { reserveResearchCall } from '../../lib/research/limits'

test('concurrent retries share the same durable search allowance', async () => {
  const store = createResearchMemoryState()
  const deps = {
    store,
    /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () =>
      1000,
    deadline: 301000,
  }
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      reserveResearchCall('job', 'web-search', deps)
    )
  )
  expect(results.filter((value) => value === 'reserved')).toHaveLength(3)
  expect(await reserveResearchCall('job', 'web-search', { ...deps })).toBe(
    'exhausted'
  )
})

test('a persisted deadline prevents new requests after a restart', async () => {
  const store = createResearchMemoryState()
  expect(
    await reserveResearchCall('job', 'model', {
      store,
      /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () =>
        20,
      deadline: 10,
    })
  ).toBe('exhausted')
  expect(await store.read('limits/job')).toBeNull()
})
