import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { GET } from '../../app/api/research/providers/route'

const mocks = vi.hoisted(() => ({
  connection: vi.fn(),
  actor: vi.fn(),
  fetch: vi.fn(),
}))
vi.mock('next/server', () => ({ connection: mocks.connection }))
vi.mock('../../lib/server/context', () => ({ currentActor: mocks.actor }))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.connection.mockResolvedValue(undefined)
  mocks.actor.mockResolvedValue({
    ok: true,
    actor: { uid: 'owner', role: 'owner' },
  })
  vi.stubGlobal('fetch', mocks.fetch)
  vi.stubEnv('SERPER_API_KEY', 'serper-secret-value')
  vi.stubEnv('BRAVE_API_KEY', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

test('only Owners can read search provider health', async () => {
  mocks.actor.mockResolvedValue({
    ok: true,
    actor: { uid: 'editor', role: 'editor' },
  })
  const response = await GET(
    new Request('https://example.com/api/research/providers')
  )
  expect(response.status).toBe(403)
  expect(mocks.fetch).not.toHaveBeenCalled()
})

test('the default check reads configuration without spending a search', async () => {
  const response = await GET(
    new Request('https://example.com/api/research/providers')
  )
  const body = await response.json()
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(body.providers).toEqual([
    expect.objectContaining({ provider: 'serper', status: 'configured' }),
    expect.objectContaining({
      provider: 'brave',
      status: 'missing_key',
      envVar: 'BRAVE_API_KEY',
    }),
  ])
  expect(mocks.fetch).not.toHaveBeenCalled()
  expect(JSON.stringify(body)).not.toContain('serper-secret-value')
})

test('a probe spends one search per configured provider and hides the key', async () => {
  mocks.fetch.mockResolvedValue(
    Response.json({ message: 'Not enough credits' }, { status: 400 })
  )
  const response = await GET(
    new Request('https://example.com/api/research/providers?probe=1')
  )
  const body = await response.json()
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  expect(body.providers[0]).toMatchObject({
    provider: 'serper',
    status: 'over_quota',
    checked: true,
  })
  expect(JSON.stringify(body)).not.toContain('serper-secret-value')
})
