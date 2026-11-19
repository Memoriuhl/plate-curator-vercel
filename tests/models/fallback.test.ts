import { afterEach, expect, test, vi } from 'vitest'
import { gatewayAdapter } from '../../worker/model'
import type { HostedModelBinding } from '../../lib/models/selection'

const model = 'openai/test-vision'
const fallback = 'google/gemma-4-26b-a4b-it'
const price = { input: 0.0000001, output: 0.0000004 }
const binding = (strict: boolean): HostedModelBinding => ({
  model,
  price,
  strict,
  capUsd: 0.01,
  ...(strict ? {} : { fallback: { model: fallback, price } }),
})
const input = {
  imageB64: 'AA==',
  plate: { displayName: 'Plate', state: 'AK', tags: [] },
}
const complete = (model: string) =>
  Response.json({
    model,
    choices: [{ message: { content: '{"tags":["blue"]}' } }],
  })

afterEach(() => vi.unstubAllEnvs())

test('Tag sends the Gateway fallback list and records the serving model', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => complete(fallback))
  const adapter = gatewayAdapter({
    apiKey: 'fixture',
    model,
    binding: binding(false),
    fetch,
  })
  await expect(adapter.suggest(input)).resolves.toMatchObject({
    model: fallback,
  })
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
    model,
    providerOptions: { gateway: { models: [fallback] } },
  })
})

test('preview fault bypasses the primary model or gives a named Strict error before the request', async () => {
  vi.stubEnv('FORCE_MODEL_FAILURE', model)
  vi.stubEnv('VERCEL_ENV', 'preview')
  const fetch = vi.fn<typeof globalThis.fetch>(async () => complete(fallback))
  const make = (strict: boolean) =>
    gatewayAdapter({
      apiKey: 'fixture',
      model,
      binding: binding(strict),
      fetch,
    })
  await expect(make(true).suggest(input)).rejects.toThrow('strict_model_failed')
  expect(fetch).not.toHaveBeenCalled()
  await expect(make(false).suggest(input)).resolves.toMatchObject({
    model: fallback,
  })
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
    model: fallback,
  })
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).not.toHaveProperty(
    'providerOptions'
  )
})
