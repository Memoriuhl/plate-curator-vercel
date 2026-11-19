import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const sample = (
  id: string,
  tags = ['vision', 'tool-use'],
  input: string | null = '0.0000001',
  type = 'language'
) => ({
  id,
  name: id,
  owned_by: id.split('/')[0],
  type,
  tags,
  pricing: { input, output: '0.0000004' },
})

const data = [
  sample('google/gemma-4-26b-a4b-it'),
  sample('google/gemini-2.5-flash-lite', ['tool-use']),
  sample('google/gemini-3.8-flash', ['vision'], '0.00001'),
  sample('openai/vision-only', ['vision']),
  sample('openai/tool-only', ['tool-use']),
  sample('openai/exact-cap', ['vision'], '0.000001936'),
  sample('openai/cheap-batch'),
  sample('openai/image', ['vision'], '0.0000001', 'image'),
  sample('openai/no-price', ['vision'], null),
]

const fetchCatalog = vi.fn()

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['Date'] })
  fetchCatalog
    .mockReset()
    .mockImplementation(async () => Response.json({ data }))
  vi.stubGlobal('fetch', fetchCatalog)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('uses capability, language type, live prices and the inclusive cap for search', async () => {
  const { searchable } = await import('../../lib/models/catalog')
  const tag = await searchable('tag', 0.005)
  expect(tag.map(({ id }) => id)).toEqual([
    'google/gemma-4-26b-a4b-it',
    'openai/vision-only',
    'openai/exact-cap',
  ])
  expect(tag[2].estimatedUsd).toBeCloseTo(0.005, 10)
  const research = await searchable('research', 0.002)
  expect(research.map(({ id }) => id)).toEqual([
    'google/gemma-4-26b-a4b-it',
    'google/gemini-2.5-flash-lite',
    'openai/tool-only',
  ])
  expect(research[0].estimatedUsd).toBeCloseTo(0.0016, 10)
})

test('curated models keep order and measured data and omit unavailable and over-cap entries', async () => {
  const { curated } = await import('../../lib/models/catalog')
  expect(await curated('tag', 0.005)).toMatchObject([
    { id: 'google/gemma-4-26b-a4b-it', measured: { f1: 0.676 } },
  ])
  expect((await curated('research')).map(({ id }) => id)).toEqual([
    'google/gemini-2.5-flash-lite',
    'google/gemma-4-26b-a4b-it',
  ])
})

test('coalesces catalog requests, refreshes after an hour, and retries failed refreshes', async () => {
  const { curated, searchable } = await import('../../lib/models/catalog')
  await Promise.all([curated('tag'), searchable('research', 0.02)])
  vi.setSystemTime(Date.now() + 3_599_000)
  await curated('research')
  expect(fetchCatalog).toHaveBeenCalledTimes(1)
  expect(fetchCatalog.mock.calls[0][0]).toBe(
    'https://ai-gateway.vercel.sh/v1/models'
  )
  vi.setSystemTime(Date.now() + 1000)
  fetchCatalog.mockResolvedValueOnce(new Response(null, { status: 503 }))
  await expect(curated('research')).rejects.toThrow(
    'Gateway model catalog unavailable'
  )
  await curated('research')
  expect(fetchCatalog).toHaveBeenCalledTimes(3)
})
