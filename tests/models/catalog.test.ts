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
  sample('google/gemma-4-26b-a4b-it', ['vision', 'tool-use', 'reasoning']),
  sample('google/gemini-2.5-flash-lite', ['tool-use', 'reasoning']),
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
    { id: 'google/gemma-4-26b-a4b-it', measured: { f1: 0.647059 } },
  ])
  expect((await curated('research')).map(({ id }) => id)).toEqual([
    'google/gemini-2.5-flash-lite',
    'google/gemma-4-26b-a4b-it',
  ])
})

test('the picker includes a reasoning model whose typical estimate fits the cap', async () => {
  const { searchable } = await import('../../lib/models/catalog')
  const models = await searchable('research', 0.002)
  const pinned = models.find(({ id }) => id === 'google/gemini-2.5-flash-lite')
  expect(pinned?.estimatedUsd).toBeCloseTo(0.0016, 10)
})

test.each([
  {
    primary: ['tool-use', 'reasoning'],
    fallback: ['tool-use'],
    holds: [8000, 1000],
  },
  {
    primary: ['tool-use'],
    fallback: ['tool-use', 'reasoning'],
    holds: [1000, 8000],
  },
])(
  'snapshots $holds output tokens for the primary and fallback',
  async ({ primary, fallback, holds }) => {
    fetchCatalog.mockResolvedValueOnce(
      Response.json({
        data: [
          sample('openai/tool-only', primary),
          sample('google/gemini-2.5-flash-lite', fallback),
        ],
      })
    )
    const { bindHostedModel } = await import('../../lib/jobs/model-binding')
    await expect(
      bindHostedModel('research', 'openai/tool-only', {})
    ).resolves.toMatchObject({
      ok: true,
      binding: {
        model: 'openai/tool-only',
        price: { input: 0.0000001, output: 0.0000004 },
        outputTokensBound: holds[0],
        fallback: {
          model: 'google/gemini-2.5-flash-lite',
          price: { input: 0.0000001, output: 0.0000004 },
          outputTokensBound: holds[1],
        },
      },
    })
  }
)

test('includes the scored Tag benchmark metrics for an available curated model', async () => {
  const id = 'google/gemini-3.5-flash-lite'
  fetchCatalog.mockResolvedValueOnce(Response.json({ data: [sample(id)] }))
  const { curated } = await import('../../lib/models/catalog')
  expect(await curated('tag')).toMatchObject([
    {
      id,
      measured: {
        f1: 0.687285,
        p50Seconds: 1.485,
        costPerPlate: 0.0011247,
        plates: 15,
      },
    },
  ])
})

test('coalesces requests, serves the last catalog on refresh failure, and recovers', async () => {
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
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await expect(curated('research')).resolves.toMatchObject([
    { id: 'google/gemini-2.5-flash-lite' },
    { id: 'google/gemma-4-26b-a4b-it' },
  ])
  expect(warning).toHaveBeenCalledWith(
    expect.objectContaining({
      cause: expect.objectContaining({ message: 'HTTP 503' }),
    })
  )
  warning.mockRestore()
  vi.setSystemTime(Date.now() + 60_000)
  await curated('research')
  expect(fetchCatalog).toHaveBeenCalledTimes(3)
})

test('binds only the pinned defaults with code prices when the cold catalog fails', async () => {
  fetchCatalog.mockRejectedValue(Error('unreachable'))
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { searchable } = await import('../../lib/models/catalog')
  const { bindHostedModel, hostedModelCatalog } =
    await import('../../lib/jobs/model-binding')
  for (const [step, id, input, output] of [
    ['research', 'google/gemini-2.5-flash-lite', 0.0000001, 0.0000004],
    ['tag', 'google/gemma-4-26b-a4b-it', 0.00000015, 0.0000006],
  ] as const) {
    await expect(searchable(step, 0.01)).resolves.toEqual([])
    await expect(hostedModelCatalog(step)).resolves.toMatchObject({
      unavailable: true,
      searchable: [],
      curated: [{ id }],
    })
    await expect(
      bindHostedModel(step, id, { capUsd: 0.002, strict: true })
    ).resolves.toMatchObject({
      ok: true,
      binding: {
        model: id,
        price: { input, output },
        outputTokensBound: 8000,
        capUsd: 0.002,
        strict: true,
      },
    })
    await expect(bindHostedModel(step, 'openai/custom', {})).resolves.toEqual({
      ok: false,
      error: 'unavailable',
    })
  }
  warning.mockRestore()
})
