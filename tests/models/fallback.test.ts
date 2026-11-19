import { afterEach, expect, test, vi } from 'vitest'
import { gatewayAdapter } from '../../worker/model'
import type { HostedModelBinding } from '../../lib/models/selection'
import { FORCED_FAILURE_SUFFIX } from '../../lib/models/routing'

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

/** Behaves like AI Gateway for an unservable id (probed 2026-11-18). */
const gatewayFake = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
  const body = JSON.parse(String(init?.body))
  if (!body.model.endsWith(FORCED_FAILURE_SUFFIX)) return complete(body.model)
  const next = body.providerOptions?.gateway?.models?.[0]
  return next
    ? complete(next)
    : Response.json(
        {
          error: {
            message: `Model '${body.model}' not found`,
            type: 'model_not_found',
          },
        },
        { status: 404 }
      )
})

test('preview fault makes the Gateway fail the primary, so its fallback or a Strict error runs for real', async () => {
  vi.stubEnv('FORCE_MODEL_FAILURE', model)
  vi.stubEnv('VERCEL_ENV', 'preview')
  gatewayFake.mockClear()
  const make = (strict: boolean) =>
    gatewayAdapter({
      apiKey: 'fixture',
      model,
      binding: binding(strict),
      fetch: gatewayFake,
    })
  await expect(make(true).suggest(input)).rejects.toThrow('strict_model_failed')
  expect(JSON.parse(String(gatewayFake.mock.calls[0][1]?.body))).toMatchObject({
    model: `${model}${FORCED_FAILURE_SUFFIX}`,
  })
  expect(
    JSON.parse(String(gatewayFake.mock.calls[0][1]?.body))
  ).not.toHaveProperty('providerOptions')
  await expect(make(false).suggest(input)).resolves.toMatchObject({
    model: fallback,
  })
  expect(JSON.parse(String(gatewayFake.mock.calls[1][1]?.body))).toMatchObject({
    model: `${model}${FORCED_FAILURE_SUFFIX}`,
    providerOptions: { gateway: { models: [fallback] } },
  })
})

test('production ignores the fault switch', async () => {
  vi.stubEnv('FORCE_MODEL_FAILURE', model)
  vi.stubEnv('VERCEL_ENV', 'production')
  gatewayFake.mockClear()
  const adapter = gatewayAdapter({
    apiKey: 'fixture',
    model,
    binding: binding(false),
    fetch: gatewayFake,
  })
  await expect(adapter.suggest(input)).resolves.toMatchObject({ model })
  expect(JSON.parse(String(gatewayFake.mock.calls[0][1]?.body)).model).toBe(
    model
  )
})
