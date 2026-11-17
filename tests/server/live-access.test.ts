import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ currentActor: vi.fn(), write: vi.fn() }))
vi.mock('../../lib/server/context', () => ({
  currentActor: mocks.currentActor,
  liveAccessDeps: () => ({ env: 'preview:feat/x', now: () => new Date('2026-11-16T12:00:00.000Z'), write: mocks.write }),
}))
const { POST } = await import('../../app/api/live-access/route')
const request = () => new Request('https://example.com/api/live-access', { method: 'POST', headers: { Authorization: 'Bearer token' } })

beforeEach(() => { vi.clearAllMocks() })

test.each(['editor', 'owner'])('grants authenticated %s access with a private uncached response', async role => {
  mocks.currentActor.mockResolvedValue({ ok: true, actor: { uid: 'member', name: null, role } })
  const req = request()
  const response = await POST(req)
  expect(mocks.currentActor).toHaveBeenCalledWith(req)
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await response.json()).toEqual({ envKey: 'preview%3Afeat%2Fx', expiresAt: '2026-11-16T13:00:00.000Z' })
  expect(mocks.write).toHaveBeenCalledExactlyOnceWith('member', 'preview%3Afeat%2Fx', new Date('2026-11-16T13:00:00.000Z'))
})

test.each([[401, 'unauthenticated'], [403, 'not_member']])('preserves auth failure %s without writing a grant', async (status, error) => {
  mocks.currentActor.mockResolvedValue({ ok: false, response: Response.json({ error }, { status: Number(status) }) })
  const response = await POST(request())
  expect(response.status).toBe(status)
  expect(await response.json()).toEqual({ error })
  expect(mocks.write).not.toHaveBeenCalled()
})
