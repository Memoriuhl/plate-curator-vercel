import { expect, test } from 'vitest'
import { createResearchMemoryState } from '../../lib/research/state'
import { searchWeb } from '../../lib/research/search'

test('an unavailable Serper key falls through to Brave and repeat queries use attributed cache', async () => {
  const store = createResearchMemoryState()
  let requests = 0
  const deps = { store, now: () => 1000, reserve: async () => true, keys: { brave: 'fixture' }, fetch: (async (url: string | URL | Request) => {
    requests++
    expect(String(url)).toContain('api.search.brave.com')
    return Response.json({ web: { results: [{ title: 'Plate', url: 'https://example.com/plate', description: 'A search snippet' }] } })
  }) as typeof fetch }
  expect(await searchWeb('Arizona Plate', deps)).toMatchObject({ status: 'ok', provider: 'brave', cached: false })
  expect(await searchWeb(' arizona plate ', deps)).toMatchObject({ status: 'ok', provider: 'brave', cached: true })
  expect(requests).toBe(1)
})

test('legacy provider errors are explicit and do not silently trigger a second billed search', async () => {
  let requests = 0
  const result = await searchWeb('Plate', { store: createResearchMemoryState(), now: () => 0, keys: { serper: 'fixture', brave: 'fixture' }, reserve: async () => true, fetch: (async () => { requests++; return new Response('', { status: 503 }) }) as typeof fetch })
  expect(result).toMatchObject({ status: 'error', provider: 'serper' })
  expect(requests).toBe(1)
})

test('exhaustion prevents external requests and search hits carry no fetched evidence', async () => {
  const store = createResearchMemoryState()
  const result = await searchWeb('Plate', { store, now: () => 0, keys: { serper: 'fixture' }, reserve: async () => false, fetch: (async () => { throw new Error('must not fetch') }) as typeof fetch })
  expect(result.status).toBe('exhausted')
  expect(result.hits).toEqual([])
  expect(await store.read('search-usage/serper')).toMatchObject({ count: 0 })
})
