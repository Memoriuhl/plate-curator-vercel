import { expect, test, vi } from 'vitest'
import type { ResearchResult } from '../../lib/research/types'
import { researchFixture } from './fixture'
import { runResearchWorkerOnce } from '../../worker/research-run'

test('a rejected claim stops the desktop bridge before invoking Ollama', async () => {
  let ran = false
  const outcome = await runResearchWorkerOnce({ apiBase: 'https://example.com', token: 'fixture', fetch: (async () => new Response('', { status: 401 })) as typeof fetch, run: async () => { ran = true; throw new Error('should not run') }, heartbeatMs: 1000, sleep: async () => undefined })
  expect(outcome).toBe('stopped')
  expect(ran).toBe(false)
})

test('idle desktop polling makes no model calls', async () => {
  expect(await runResearchWorkerOnce({ apiBase: 'https://example.com', token: 'fixture', fetch: (async () => new Response(null, { status: 204 })) as typeof fetch, run: async () => { throw new Error('should not run') }, heartbeatMs: 1000, sleep: async () => undefined })).toBe('idle')
})

test('a long-running desktop result renews its claim and reports only staged data', async () => {
  vi.useFakeTimers()
  try {
    const f = researchFixture()
    const started = await f.start()
    if (!started.ok) throw new Error('setup')
    let finish!: (result: ResearchResult) => void
    const calls: string[] = []
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url))
      if (String(url).endsWith('/claim')) return Response.json({ job: started.value, claimId: 'claim', leaseExpiresAt: Date.now() + 5000 })
      if (String(url).endsWith('/heartbeat')) return Response.json({ ok: true, value: { leaseExpiresAt: Date.now() + 5000 } })
      return Response.json({ ok: true })
    })
    const outcome = runResearchWorkerOnce({ apiBase: 'https://example.com', token: 'fixture', fetch: fetcher as typeof fetch, run: () => new Promise(resolve => { finish = resolve }), heartbeatMs: 1000, sleep: async () => undefined })
    await vi.advanceTimersByTimeAsync(1100)
    expect(calls.some(url => url.endsWith('/heartbeat'))).toBe(true)
    finish(f.result(started.value))
    expect(await outcome).toBe('reported')
    expect(calls.at(-1)).toMatch(/\/report$/)
    expect(calls.some(url => /accept|publish|plates\//.test(url))).toBe(false)
  } finally { vi.useRealTimers() }
})
