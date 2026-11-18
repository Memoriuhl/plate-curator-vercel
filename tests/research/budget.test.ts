import { expect, test } from 'vitest'
import { createResearchMemoryState } from '../../lib/research/state'
import { reserveResearchSpend, settleResearchModelSpend } from '../../lib/research/budget'
import { createResearchModelAttempt } from '../../lib/research/model-attempt'

test('parallel callers share one two-dollar budget and cannot start excess requests', async () => {
  const store = createResearchMemoryState()
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => reserveResearchSpend(store, 'campaign', `run-${index}`, 'model', 0.2, 2)))
  expect(results.filter(Boolean)).toHaveLength(10)
  expect(await reserveResearchSpend(store, 'campaign', 'run', 'search', 0.01, 2)).toBe(false)
})

test('known model charges release unused reservations while unknown charges remain reserved', async () => {
  const store = createResearchMemoryState()
  await reserveResearchSpend(store, 'campaign', 'first', 'model', 0.2, 2)
  await reserveResearchSpend(store, 'campaign', 'first', 'search', 0.01, 2)
  await settleResearchModelSpend(store, 'campaign', 'first', 0.02)
  expect(await store.read('budget/campaign')).toMatchObject({ committedMicros: 30000 })
  await reserveResearchSpend(store, 'campaign', 'second', 'model', 0.2, 2)
  await settleResearchModelSpend(store, 'campaign', 'second', undefined)
  expect(await store.read('budget/campaign')).toMatchObject({ committedMicros: 230000 })
})

test('a captured-evidence run permits one physical synthesis attempt with no silent retry or search model', async () => {
  const store = createResearchMemoryState()
  const options = { campaign: 'captured', limitUsd: 2, deadline: Date.now() + 10000, maxCalls: 1 }
  const first = await createResearchModelAttempt(store, 'plate', options)
  await first.settle(0.000128, { inputTokens: 800, outputTokens: 120 })
  await expect(createResearchModelAttempt(store, 'plate', options)).rejects.toThrow('model limit exhausted')
  expect(await store.read('limits/plate')).toEqual({ model: 1 })
  expect(await store.read('usage/plate')).toEqual({ inputTokens: 800, outputTokens: 120 })
})
