import { expect, test, vi } from 'vitest'
import { ApiError, createApiClient } from '../../lib/client/api'

/**
 * Create a mocked fetch response with the status and JSON needed by the API client test.
 */
function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

test('attaches the bearer token and parses JSON', async () => {
  const fetch = fakeFetch(200, { ok: 1 })
  const api = createApiClient({ /** Provide a test credential so the request can exercise the intended authentication path. */ token: async () => 'tok', fetch })

  expect(await api.get('/api/me')).toEqual({ ok: 1 })
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('/api/me')
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok')
})

test('sends JSON bodies for writes', async () => {
  const fetch = fakeFetch(200, {})
  const api = createApiClient({ /** Provide a test credential so the request can exercise the intended authentication path. */ token: async () => 'tok', fetch })

  await api.send('PATCH', '/api/batches/b1/plates/p1', { baseRevision: 'r', fields: { tags: ['x'] } })
  const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(init.method).toBe('PATCH')
  expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
  expect(JSON.parse(String(init.body))).toEqual({ baseRevision: 'r', fields: { tags: ['x'] } })
})

test('throws ApiError with status, error code and body on failure', async () => {
  const api = createApiClient({ /** Provide a test credential so the request can exercise the intended authentication path. */ token: async () => 'tok', fetch: fakeFetch(409, { error: 'stale_plate', current: { id: 'p1' } }) })

  const error = await api.get('/x').catch((e: unknown) => e)
  expect(error).toBeInstanceOf(ApiError)
  expect(error).toMatchObject({ status: 409, code: 'stale_plate', body: { current: { id: 'p1' } } })
})

test('refuses to call the API when signed out', async () => {
  const fetch = fakeFetch(200, {})
  const api = createApiClient({ /** Provide a test credential so the request can exercise the intended authentication path. */ token: async () => null, fetch })

  await expect(api.get('/x')).rejects.toMatchObject({ status: 401, code: 'unauthenticated' })
  expect(fetch).not.toHaveBeenCalled()
})
