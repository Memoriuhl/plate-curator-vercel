import { afterEach, expect, test, vi } from 'vitest'
import { createResearchMemoryState } from '../../lib/research/state'
import {
  reserveResearchSpend,
  settleResearchModelSpend,
} from '../../lib/research/budget'
import { createResearchModelAttempt } from '../../lib/research/model-attempt'
import { researchTurn } from '../../lib/research/runtime'

afterEach(() => vi.unstubAllEnvs())

test('parallel callers share one two-dollar budget and cannot start excess requests', async () => {
  const store = createResearchMemoryState()
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      reserveResearchSpend(store, 'campaign', `run-${index}`, 'model', 0.2, 2)
    )
  )
  expect(results.filter(Boolean)).toHaveLength(10)
  expect(
    await reserveResearchSpend(store, 'campaign', 'run', 'search', 0.01, 2)
  ).toBe(false)
})

test('known model charges release unused reservations while unknown charges remain reserved', async () => {
  const store = createResearchMemoryState()
  await reserveResearchSpend(store, 'campaign', 'first', 'model', 0.2, 2)
  await reserveResearchSpend(store, 'campaign', 'first', 'search', 0.01, 2)
  await settleResearchModelSpend(store, 'campaign', 'first', 0.02)
  expect(await store.read('budget/campaign')).toMatchObject({
    committedMicros: 30000,
  })
  await reserveResearchSpend(store, 'campaign', 'second', 'model', 0.2, 2)
  await settleResearchModelSpend(store, 'campaign', 'second', undefined)
  expect(await store.read('budget/campaign')).toMatchObject({
    committedMicros: 230000,
  })
})

test('a captured-evidence run permits one physical synthesis attempt with no silent retry or search model', async () => {
  const store = createResearchMemoryState()
  const options = {
    campaign: 'captured',
    limitUsd: 2,
    deadline: Date.now() + 10000,
    maxCalls: 1,
    price: { input: 0.0000001, output: 0.0000004 },
  }
  const first = await createResearchModelAttempt(store, 'plate', options)
  await first.settle(0.000128, { inputTokens: 800, outputTokens: 120 })
  await expect(
    createResearchModelAttempt(store, 'plate', options)
  ).rejects.toThrow('model limit exhausted')
  expect(await store.read('limits/plate')).toEqual({ model: 1 })
  expect(await store.read('usage/plate')).toEqual({
    inputTokens: 800,
    outputTokens: 120,
  })
})

test('queued plates share a twenty-cent campaign after an earlier charged call', async () => {
  vi.stubEnv('RESEARCH_BUDGET_ID', 'campaign')
  vi.stubEnv('RESEARCH_BUDGET_USD', '0.20')
  const store = createResearchMemoryState()
  await reserveResearchSpend(store, 'campaign', 'earlier', 'model', 0.2, 0.2)
  await settleResearchModelSpend(store, 'campaign', 'earlier', 0.0006361)

  const calls = await Promise.all(
    Array.from({ length: 32 }, async (_, index) => {
      const id = `session-${index}`
      await store.update(`session/${id}`, () => ({
        value: { pipelineJobId: `plate-${index}` },
        result: null,
      }))
      const run = await researchTurn(
        { session: { id, turn: { id: 'turn' } } },
        store
      )
      return run.modelAttempt
    })
  )
  const outcomes = await Promise.allSettled(calls.map((start) => start()))
  expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(
    31
  )
  expect(await store.read('budget/campaign')).toMatchObject({
    limitMicros: 200000,
    committedMicros: 199037,
  })
})

test('call reservations scale with the bound price and cover a more expensive fallback', async () => {
  const store = createResearchMemoryState()
  const common = {
    campaign: 'prices',
    limitUsd: 2,
    deadline: Date.now() + 10000,
  }
  const price = { input: 0.000001, output: 0.000002 }
  await createResearchModelAttempt(store, 'primary', { ...common, price })
  await createResearchModelAttempt(store, 'with-fallback', {
    ...common,
    price,
    fallbackPrice: { input: 0.000002, output: 0.000004 },
  })
  expect(await store.read('budget/prices')).toMatchObject({
    committedMicros: 186000,
    runs: {
      'primary/model/1': { modelReservedMicros: 62000 },
      'with-fallback/model/1': { modelReservedMicros: 124000 },
    },
  })
})
