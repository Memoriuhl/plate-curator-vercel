import { expect, test, vi } from 'vitest'
import {
  clientContactUrl,
  isWikimediaHost,
  localPipelineUserAgent,
  researchUserAgent,
  retryAfterMs,
  withRateLimitRetry,
} from '../../lib/research/wikimedia'
import { searchWikipedia } from '../../lib/research/wikipedia'
import { createResearchMemoryState } from '../../lib/research/state'
import { wikipediaQuery } from '../../worker/pipeline/sources'

const limited = (retryAfter?: string) =>
  new Response('slow down', {
    status: 429,
    headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  })

/** Record waits instead of sleeping so the tests run instantly. */
function recorder() {
  const waits: number[] = []
  return { waits, sleep: async (ms: number) => void waits.push(ms) }
}

test('user agents name the client and give the app URL as contact, with no email', () => {
  for (const agent of [researchUserAgent, localPipelineUserAgent]) {
    expect(agent).toMatch(/^PlateCurator\w+\/\d+\.\d+ \(https:\/\/[^)]+\)$/)
    expect(agent).toContain(clientContactUrl)
    expect(agent).not.toContain('@')
  }
})

test('Wikimedia hosts are recognized by domain, not by substring', () => {
  expect(isWikimediaHost('en.wikipedia.org')).toBe(true)
  expect(isWikimediaHost('upload.wikimedia.org')).toBe(true)
  expect(isWikimediaHost('wikipedia.org')).toBe(true)
  expect(isWikimediaHost('wikipedia.org.example.com')).toBe(false)
  expect(isWikimediaHost('notwikipedia.org')).toBe(false)
})

test('Retry-After is read as seconds or as an HTTP date', () => {
  expect(retryAfterMs('3', 0)).toBe(3000)
  expect(retryAfterMs('0', 0)).toBe(0)
  expect(retryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000)).toBe(4000)
  expect(retryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 9000)).toBe(0)
  expect(retryAfterMs(null, 0)).toBeUndefined()
  expect(retryAfterMs('soon', 0)).toBeUndefined()
  expect(retryAfterMs('-1', 0)).toBeUndefined()
})

test('a 429 waits exactly the Retry-After delay, then repeats the request', async () => {
  const { waits, sleep } = recorder()
  const send = vi
    .fn<() => Promise<Response>>()
    .mockResolvedValueOnce(limited('3'))
    .mockResolvedValueOnce(Response.json({ ok: true }))
  const response = await withRateLimitRetry(send, { sleep, now: () => 0 })
  expect(response.status).toBe(200)
  expect(send).toHaveBeenCalledTimes(2)
  expect(waits).toEqual([3000])
})

test('without Retry-After the wait doubles from one second, and retries stop after two', async () => {
  const { waits, sleep } = recorder()
  const send = vi.fn(async () => limited())
  const response = await withRateLimitRetry(send, { sleep, now: () => 0 })
  expect(response.status).toBe(429)
  expect(send).toHaveBeenCalledTimes(3)
  expect(waits).toEqual([1000, 2000])
})

test('a Retry-After longer than ten seconds is not shortened: the 429 is returned at once', async () => {
  const { waits, sleep } = recorder()
  const send = vi.fn(async () => limited('120'))
  const response = await withRateLimitRetry(send, { sleep, now: () => 0 })
  expect(response.status).toBe(429)
  expect(send).toHaveBeenCalledTimes(1)
  expect(waits).toEqual([])
})

test('other failures are returned without a retry', async () => {
  const { waits, sleep } = recorder()
  const send = vi.fn(async () => new Response('', { status: 503 }))
  expect((await withRateLimitRetry(send, { sleep })).status).toBe(503)
  expect(send).toHaveBeenCalledTimes(1)
  expect(waits).toEqual([])
})

test('the local pipeline Wikipedia query retries a 429 and sends the contact user agent', async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(limited('0'))
    .mockResolvedValueOnce(Response.json({ query: { search: [] } }))
  expect(await wikipediaQuery({ action: 'query' }, request)).toEqual({
    query: { search: [] },
  })
  expect(request).toHaveBeenCalledTimes(2)
  for (const [, init] of request.mock.calls)
    expect(new Headers(init?.headers).get('user-agent')).toBe(
      localPipelineUserAgent
    )
})

test('the local pipeline Wikipedia query still fails when Wikipedia asks for a long wait', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(limited('600'))
  await expect(wikipediaQuery({ action: 'query' }, request)).rejects.toThrow(
    'Wikipedia request failed: 429'
  )
  expect(request).toHaveBeenCalledTimes(1)
})

test('Plate-screen Wikipedia search retries a 429 without spending a second allowance', async () => {
  const reserve = vi.fn(async () => true)
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(limited('0'))
    .mockResolvedValueOnce(
      Response.json({ query: { search: [{ title: 'Purple Heart' }] } })
    )
  const hits = await searchWikipedia('Purple Heart Alaska license plate', {
    store: createResearchMemoryState(),
    fetch,
    now: () => 0,
    reserve,
  })
  expect(hits.map((hit) => hit.title)).toEqual(['Purple Heart'])
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(reserve).toHaveBeenCalledTimes(1)
  expect(new Headers(fetch.mock.calls[1][1]?.headers).get('user-agent')).toBe(
    researchUserAgent
  )
})
