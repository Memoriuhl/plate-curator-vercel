import { afterEach, expect, test, vi } from 'vitest'
import { createResearchMemoryState } from '../../lib/research/state'
import {
  reserveResearchSpend,
  settleResearchModelSpend,
} from '../../lib/research/budget'
import { createResearchModelAttempt } from '../../lib/research/models/model-attempt'
import { researchTurn } from '../../lib/research/runtime'
import { bindHostedModel } from '../../lib/jobs/model-binding'
import { installModelCatalogFixture } from '../models/fixture'

installModelCatalogFixture()
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

test('two concurrent reasoning calls cannot both reserve a campaign with 1.5 cents left', async () => {
  const store = createResearchMemoryState()
  const choice = await bindHostedModel(
    'research',
    'google/gemini-2.5-flash-lite',
    {}
  )
  if (!choice.ok) throw new Error('Expected the fixture model to bind')

  const options = {
    campaign: 'reasoning',
    limitUsd: 0.015,
    deadline: Date.now() + 10000,
    ...choice.binding,
  }
  const results = await Promise.allSettled([
    createResearchModelAttempt(store, 'first', options),
    createResearchModelAttempt(store, 'second', options),
  ])
  expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
  expect(results).toContainEqual({
    status: 'rejected',
    reason: new Error('Research campaign budget exhausted'),
  })
  expect(await store.read('budget/reasoning')).toMatchObject({
    committedMicros: 9200,
  })
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
    21
  )
  expect(await store.read('budget/campaign')).toMatchObject({
    limitMicros: 200000,
    committedMicros: 193837,
  })
})

const price = { input: 0.000001, output: 0.000002 }
const fallbackPrice = { input: 0.000002, output: 0.000004 }

test.each([
  ['standard primary', { outputTokensBound: 1000 }, 62000],
  ['reasoning primary', { outputTokensBound: 8000 }, 76000],
  ['legacy primary', {}, 76000],
  [
    'standard fallback',
    {
      outputTokensBound: 8000,
      fallback: { price: fallbackPrice, outputTokensBound: 1000 },
    },
    124000,
  ],
  [
    'reasoning fallback',
    {
      outputTokensBound: 1000,
      fallback: { price: fallbackPrice, outputTokensBound: 8000 },
    },
    152000,
  ],
  [
    'legacy fallback',
    { outputTokensBound: 1000, fallback: { price: fallbackPrice } },
    152000,
  ],
  [
    'higher-cost primary',
    { outputTokensBound: 8000, fallback: { price, outputTokensBound: 1000 } },
    76000,
  ],
] as const)(
  'reserves %s at its snapshotted rates',
  async (_, snapshot, expected) => {
    const store = createResearchMemoryState()
    await createResearchModelAttempt(store, 'plate', {
      campaign: 'prices',
      limitUsd: 2,
      deadline: Date.now() + 10000,
      price,
      ...snapshot,
    })
    expect(await store.read('budget/prices')).toMatchObject({
      committedMicros: expected,
    })
  }
)
