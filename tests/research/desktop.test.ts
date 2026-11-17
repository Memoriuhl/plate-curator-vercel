import { expect, test } from 'vitest'
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
