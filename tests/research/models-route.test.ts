import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { GET } from '../../app/api/research/models/route'

const mocks = vi.hoisted(() => ({ connection: vi.fn(), actor: vi.fn() }))
vi.mock('next/server', () => ({ connection: mocks.connection }))
vi.mock('../../lib/server/context', () => ({ currentActor: mocks.actor }))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.connection.mockResolvedValue(undefined)
  mocks.actor.mockResolvedValue({ ok: true, actor: { uid: 'owner', role: 'owner' } })
  vi.stubEnv('RESEARCH_ENABLE_MODEL_CALLS', 'true')
})
afterEach(() => vi.unstubAllEnvs())

test('model discovery waits for a live request before reading authenticated runtime configuration', async () => {
  mocks.connection.mockRejectedValue(Error('Prerender has no request'))
  await expect(GET(new Request('https://example.com/api/research/models'))).rejects.toThrow('Prerender has no request')
  expect(mocks.actor).not.toHaveBeenCalled()
})

test.each([
  ['owner', 'true', true], ['editor', 'true', false], ['owner', 'false', false],
])('model discovery for %s with calls %s returns only permitted choices', async (role, enabled, hosted) => {
  mocks.actor.mockResolvedValue({ ok: true, actor: { uid: 'member', role } })
  vi.stubEnv('RESEARCH_ENABLE_MODEL_CALLS', enabled)
  const response = await GET(new Request('https://example.com/api/research/models'))
  const result = await response.json()
  expect(result.models.some((model: { executor: string }) => model.executor === 'eve')).toBe(hosted)
  expect(result.default).toBe('desktop-gemma4-12b')
  expect(response.headers.get('cache-control')).toContain('no-store')
})

test('unauthenticated model discovery preserves the authentication refusal', async () => {
  mocks.actor.mockResolvedValue({ ok: false, response: Response.json({ error: 'unauthenticated' }, { status: 401 }) })
  expect((await GET(new Request('https://example.com/api/research/models'))).status).toBe(401)
})
