import { afterEach, expect, test, vi } from 'vitest'
import {
  chooseRunResearchModel,
  chooseRunTaggingModel,
} from '../../lib/jobs/model-binding'

vi.mock('../../lib/models/catalog', async (original) => ({
  ...(await original<typeof import('../../lib/models/catalog')>()),
  searchable: async (step: string, capUsd: number) =>
    [
      { id: 'openai/vision-only', estimatedUsd: 0.001, tag: true },
      { id: 'openai/tool-only', estimatedUsd: 0.001 },
      { id: 'openai/expensive', estimatedUsd: 0.009, tag: true },
      { id: 'google/gemma-4-26b-a4b-it', estimatedUsd: 0.0006, tag: true },
      { id: 'google/gemini-2.5-flash-lite', estimatedUsd: 0.0016 },
    ]
      .filter(
        (model) =>
          (step === 'tag' ? model.tag : !model.tag) &&
          model.estimatedUsd <= capUsd
      )
      .map((model) => ({
        ...model,
        label: model.id,
        price: { input: 0.0000001, output: 0.0000004 },
      })),
}))

afterEach(() => vi.unstubAllEnvs())

const gateway = 'gateway-gemma4-26b'
test.each([
  ['openai/unknown', { capUsd: 0.005 }],
  ['openai/tool-only', { capUsd: 0.005 }],
  ['openai/vision-only-batch', { capUsd: 0.005 }],
  ['openai/expensive', { capUsd: 0.005 }],
  ['openai/vision-only', { capUsd: 0.0051 }],
  ['openai/vision-only', { capUsd: 0.02 }],
])('rejects an invalid Tag selection %s with %j', async (id, options) => {
  vi.stubEnv('TAGGING_MODELS', gateway)
  vi.stubEnv('HOSTED_MODEL_MAX_USD_PER_PLATE', '0.01')
  expect(await chooseRunTaggingModel(id, options, true)).toEqual({
    ok: false,
    error: 'bad_request',
  })
})

test('binds a valid choice, strict flag, and immutable prices', async () => {
  vi.stubEnv('TAGGING_MODELS', gateway)
  expect(
    await chooseRunTaggingModel(
      'openai/vision-only',
      { capUsd: 0.005, strict: true },
      true
    )
  ).toMatchObject({
    ok: true,
    model: { id: 'openai/vision-only', runsOn: 'gateway' },
    binding: {
      model: 'openai/vision-only',
      price: { input: 0.0000001, output: 0.0000004 },
      capUsd: 0.005,
      strict: true,
    },
  })
  expect(
    await chooseRunResearchModel('openai/tool-only', {}, true, true)
  ).toMatchObject({
    ok: true,
    binding: { model: 'openai/tool-only', capUsd: 0.01, strict: false },
  })
})

test('checks Owner access and hosted availability for both steps', async () => {
  vi.stubEnv('TAGGING_MODELS', gateway)
  expect(await chooseRunTaggingModel(gateway, undefined, false)).toEqual({
    ok: false,
    error: 'unavailable',
  })
  expect(
    await chooseRunResearchModel('openai/tool-only', undefined, true, false)
  ).toEqual({ ok: false, error: 'unavailable' })
  vi.stubEnv('TAGGING_MODELS', 'desktop-gemma4-12b')
  expect(
    await chooseRunTaggingModel('openai/vision-only', undefined, true)
  ).toEqual({ ok: false, error: 'unavailable' })
  expect(
    await chooseRunResearchModel('openai/tool-only', undefined, false, true)
  ).toEqual({ ok: false, error: 'unavailable' })
})
