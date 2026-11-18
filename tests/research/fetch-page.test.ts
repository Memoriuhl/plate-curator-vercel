import { expect, test } from 'vitest'
import { fetchResearchPage } from '../../lib/research/fetch-page'

/** Resolve the source to a public fixture IP without performing real DNS. */
const publicResolve = async () => ['93.184.216.34']
const page = '<article><p>' + 'This plate funds habitat protection and honors the wildlife of the state. '.repeat(6) + '</p></article>'

test('a public fetched page becomes bounded evidence with final URL and content hash', async () => {
  const source = await fetchResearchPage('https://example.com/a', { resolve: publicResolve, /** Allow the fixture evidence request without consuming a real tool budget. */ reserve: async () => true, fetch: (async () => new Response(page, { headers: { 'content-type': 'text/html' } })) as typeof fetch, /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () => 0 })
  expect(source).toMatchObject({ kind: 'web', url: 'https://example.com/a', contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(source!.text).not.toContain('<article>')
})

test('redirect destinations are checked before any private request', async () => {
  let requests = 0
  const source = await fetchResearchPage('https://example.com/a', { /** Resolve the initial host publicly and the redirect privately to exercise destination checks. */ resolve: async host => host === 'example.com' ? ['93.184.216.34'] : [['127', '0', '0', '1'].join('.')], /** Allow the fixture evidence request without consuming a real tool budget. */ reserve: async () => true, fetch: (async () => { requests++; return new Response('', { status: 302, headers: { location: 'http://localhost/private' } }) }) as typeof fetch, /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () => 0 })
  expect(source).toBeNull()
  expect(requests).toBe(1)
})

test('unsupported content and oversized responses do not become evidence', async () => {
  for (const response of [new Response('binary', { headers: { 'content-type': 'image/png' } }), new Response('x'.repeat(300), { headers: { 'content-type': 'text/plain', 'content-length': '1500001' } })]) {
    expect(await fetchResearchPage('https://example.com/a', { resolve: publicResolve, /** Allow the fixture evidence request without consuming a real tool budget. */ reserve: async () => true, fetch: (async () => response) as typeof fetch, /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () => 0 })).toBeNull()
  }
})
