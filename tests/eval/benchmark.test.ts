import { expect, test, vi } from 'vitest'
import { benchmark, boundedPool, RequestBudget } from '../../worker/benchmark'
import { gatewayAdapter, ollamaAdapter } from '../../worker/model'
import { reportHtml, summaryCsv } from '../../worker/report'
import {
  modelReportHtml,
  modelSummaryCsv,
  type ModelLane,
} from '../../worker/model-report'

const input = {
  imageB64: Buffer.from('RIFFfakeWEBP').toString('base64'),
  plate: { displayName: 'Bear', state: 'AK', tags: [] },
}
const completion = JSON.stringify({
  primaryColor: 'white',
  subjects: ['bears'],
})
const pricing = { input: '0.0000003', output: '0.0000025' }
/** Return a successful inference response with known model identity, usage and cost. */
const success = () =>
  Response.json({
    model: 'returned-model',
    choices: [{ message: { content: completion } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 },
  })

test('gateway uses local prompts, image bytes, normalization, and reported usage and cost', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => success())
  const onAttempt = vi.fn()
  const hosted = gatewayAdapter({
    apiKey: 'test-key',
    pricing,
    fetch: request,
    onAttempt,
  })
  const result = await hosted.suggest(input)
  const body = JSON.parse(String(request.mock.calls[0][1]?.body))
  const localRequest = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ message: { content: completion } }))
  const local = ollamaAdapter({
    url: 'http://localhost',
    model: 'local',
    fetch: localRequest,
  })
  expect((await local.suggest(input)).tags).toEqual(result.tags)
  const localBody = JSON.parse(String(localRequest.mock.calls[0][1]?.body))
  expect(body.model).toBe('google/gemini-3.5-flash-lite')
  expect(body.temperature).toBe(0.1)
  expect(body.messages[0]).toEqual(localBody.messages[0])
  expect(body.messages[1].content[0].text).toBe(localBody.messages[1].content)
  expect(body.messages[1].content[1].image_url.url).toBe(
    `data:image/webp;base64,${input.imageB64}`
  )
  expect(
    new Headers(request.mock.calls[0][1]?.headers).get('Authorization')
  ).toBe('Bearer test-key')
  expect(onAttempt).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'returned-model',
      cost: 0.001,
      costSource: 'reported',
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 },
    })
  )
})

test('pricing is fetched once and missing charges are estimated', async () => {
  const onAttempt = vi.fn()
  const request = vi.fn<typeof fetch>().mockImplementation(async (url) =>
    String(url).endsWith('/models')
      ? Response.json({
          data: [
            { id: 'google/gemini-3.5-flash-lite', tags: ['vision'], pricing },
          ],
        })
      : Response.json({
          choices: [{ message: { content: completion } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        })
  )
  const adapter = gatewayAdapter({ apiKey: 'test', fetch: request, onAttempt })
  await adapter.suggest(input)
  await adapter.suggest(input)
  expect(
    request.mock.calls.filter(([url]) => String(url).endsWith('/models'))
  ).toHaveLength(1)
  expect(onAttempt.mock.calls[0][0].costSource).toBe('estimated')
  expect(onAttempt.mock.calls[0][0].cost).toBeCloseTo(0.00008, 10)
})

test('non-2xx throws status and records a 429 attempt', async () => {
  const onAttempt = vi.fn()
  const adapter = gatewayAdapter({
    apiKey: 'test',
    pricing,
    fetch: vi.fn(async () => new Response(null, { status: 429 })),
    onAttempt,
  })
  await expect(adapter.suggest(input)).rejects.toMatchObject({ status: 429 })
  expect(onAttempt.mock.calls[0][0].status).toBe(429)
})

test('bounded pool preserves order and never exceeds concurrency', async () => {
  let active = 0
  let maximum = 0
  const results = await boundedPool([4, 3, 2, 1], 2, async (value) => {
    maximum = Math.max(maximum, ++active)
    await new Promise((resolve) => setTimeout(resolve, value))
    active--
    return value * 2
  })
  expect(results).toEqual([8, 6, 4, 2])
  expect(maximum).toBe(2)
})

test('comparison cap includes retries and applies across runs; reports reconcile failures and missing costs', async () => {
  vi.stubEnv('AI_GATEWAY_API_KEY', 'test')
  const plates = Array.from({ length: 4 }, (_, i) => ({
    ...input.plate,
    id: String(i),
    image: 'image',
    tags: ['bear'],
  }))
  let calls = 0
  const request = vi.fn<typeof fetch>().mockImplementation(async () => {
    calls++
    if (calls === 1) return new Response(null, { status: 429 })
    if (calls === 3 || calls === 4) return new Response(null, { status: 503 })
    return success()
  })
  const budget = new RequestBudget(5)
  const common = {
    concurrency: 1,
    label: 'fixed',
    plates,
    fixtureText: 'fixture',
    minimumF1: 0.6,
    /** Provide fixture image data to the worker so the test can exercise its result without a real download. */ readImage:
      async () => input.imageB64,
    budget,
    pricing,
    request,
  }
  const hosted = await benchmark({ ...common, backend: 'hosted' })
  const local = await benchmark({ ...common, backend: 'local' })
  expect(calls).toBe(5)
  expect(budget.used).toBe(5)
  expect(hosted.rateLimits).toBe(1)
  expect(hosted.failedPlates).toBe(1)
  expect(hosted.retries).toBe(2)
  expect(hosted.status).toBe('capped')
  expect(local.requests).toBe(0)
  expect(hosted.totalCost).toBe(0.002)
  expect(hosted.costSource).toBe('reported')
  expect(hosted.missingCostAttempts).toBe(3)
  const csv = summaryCsv([local, hosted])
  expect(csv.trim().split('\n')).toHaveLength(3)
  expect(csv).toContain('"0.00200000"')
  expect(csv).toContain('"unknown"')
  const html = reportHtml([local, hosted])
  expect(html).toContain('hosted-c1.json')
  expect(html).toContain('0.00200000')
  expect(html).toContain('local-c1.json')
  expect(html).toContain('<svg')
  expect(html).not.toContain('<script')
  expect(html).toContain(
    'Low wall time with zero throughput measures rejection'
  )
  const modelLanes: ModelLane[] = [local, hosted].map((run, i) => ({
    file: `${i}.json`,
    run,
    coldLoadSeconds: i ? null : 2,
    peakVramMiB: i ? null : 10000,
    meanVramMiB: i ? null : 9000,
    meanGpuUtilization: i ? null : 80,
    spill: i ? 'unknown' : 'no',
    processor: '100% GPU',
    parallel: '1',
  }))
  expect(modelSummaryCsv(modelLanes).trim().split('\n')).toHaveLength(3)
  const modelsHtml = modelReportHtml(modelLanes, 'fixed dataset')
  expect(modelsHtml).toContain('estimated catalog USD')
  expect(modelsHtml).toContain('Same weights')
  expect(modelsHtml).toContain('0.00066667')
  expect(modelsHtml).toContain('10000')
  expect(modelsHtml.match(/<table>/g)).toHaveLength(1)
  expect(modelsHtml).not.toContain('<script')
  vi.unstubAllEnvs()
})

test('concurrent hosted attempts stop at a shared cap without issuing extra requests', async () => {
  vi.stubEnv('AI_GATEWAY_API_KEY', 'test')
  const request = vi.fn<typeof fetch>().mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2))
    return success()
  })
  const run = await benchmark({
    backend: 'hosted',
    concurrency: 4,
    label: '',
    plates: Array.from({ length: 10 }, (_, i) => ({
      ...input.plate,
      id: String(i),
      image: 'image',
    })),
    fixtureText: '',
    minimumF1: 0.6,
    /** Provide fixture image data to the worker so the test can exercise its result without a real download. */ readImage:
      async () => input.imageB64,
    budget: new RequestBudget(3),
    pricing,
    request,
  })
  expect(request).toHaveBeenCalledTimes(3)
  expect(run.cappedPlates).toBe(7)
  expect(run.requests).toBe(3)
  expect(run.plates.map((p) => p.id)).toEqual(
    Array.from({ length: 10 }, (_, i) => String(i))
  )
  vi.unstubAllEnvs()
})

test('billable malformed completions retain usage and cost before retry', async () => {
  const onAttempt = vi.fn()
  const adapter = gatewayAdapter({
    apiKey: 'test',
    pricing,
    onAttempt,
    fetch: vi.fn(async () =>
      Response.json({
        model: 'returned',
        choices: [{ message: { content: 'invalid' } }],
        usage: { cost: 0.002, prompt_tokens: 10, completion_tokens: 4 },
      })
    ),
  })
  await expect(adapter.suggest(input)).rejects.toThrow()
  expect(onAttempt).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'returned',
      cost: 0.002,
      costSource: 'reported',
    })
  )
})

test('rate-limit threshold stops retries and queued Plates, preserving in-flight responses', async () => {
  vi.stubEnv('AI_GATEWAY_API_KEY', 'test')
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(null, { status: 429 }))
  const run = await benchmark({
    backend: 'hosted',
    concurrency: 1,
    label: '',
    plates: Array.from({ length: 30 }, (_, i) => ({
      ...input.plate,
      tags: ['bear'],
      id: String(i),
      image: 'image',
    })),
    fixtureText: '',
    minimumF1: 0.6,
    /** Provide fixture image data to the worker so the test can exercise its result without a real download. */ readImage:
      async () => input.imageB64,
    budget: new RequestBudget(400),
    pricing,
    request,
    maxRateLimitRatio: 0.2,
  })
  expect(request).toHaveBeenCalledTimes(1)
  expect(run.status).toBe('rate_limited')
  expect(run.failedPlates).toBe(1)
  expect(run.stoppedPlates).toBe(29)
  expect(run.retries).toBe(0)
  expect(run.overall.f1).toBe(0)
  vi.unstubAllEnvs()
})
