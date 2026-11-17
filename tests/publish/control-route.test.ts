import { beforeEach, expect, test, vi } from 'vitest'
import { GET, POST } from '../../app/api/publish/control/route'

const control = { paused: false, generation: 1, changedBy: { uid: 'owner', email: 'owner@example.com' }, changedAt: '2026-11-16T12:00:00Z' }
const mocks = vi.hoisted(() => ({ currentActor: vi.fn(), publishAllowed: vi.fn(), publishControl: vi.fn(), getByUid: vi.fn(), read: vi.fn(), change: vi.fn() }))
vi.mock('../../lib/server/context', () => mocks)
vi.mock('../../lib/server/members', () => ({ membersStore: () => ({ getByUid: mocks.getByUid }) }))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.currentActor.mockResolvedValue({ ok: true, actor: { uid: 'owner', role: 'owner' } })
  mocks.publishAllowed.mockReturnValue(true)
  mocks.getByUid.mockResolvedValue({ uid: 'owner', email: 'owner@example.com', role: 'owner', status: 'active' })
  mocks.publishControl.mockReturnValue({ read: mocks.read, change: mocks.change })
  mocks.read.mockResolvedValue(control)
  mocks.change.mockResolvedValue({ ...control, paused: true, generation: 2 })
})
const request = (paused = true) => new Request('http://localhost/api/publish/control', { method: 'POST', body: JSON.stringify({ paused }) })

test('Owner can read audit details and pause or resume', async () => {
  expect(await (await GET(request())).json()).toEqual({ control })
  for (const paused of [true, false]) {
    expect((await POST(request(paused))).status).toBe(200)
    expect(mocks.change).toHaveBeenLastCalledWith(paused, control.changedBy, expect.any(String))
  }
})
test.each(['editor', 'removed', 'bootstrap'])('current membership denies %s', async role => {
  mocks.getByUid.mockResolvedValue(role === 'removed' || role === 'bootstrap' ? null : { uid: 'owner', role, status: 'active' })
  expect((await POST(request())).status).toBe(403)
  expect(mocks.change).not.toHaveBeenCalled()
})
test('unauthenticated requests and disabled environments are denied', async () => {
  mocks.currentActor.mockResolvedValueOnce({ ok: false, response: Response.json({ error: 'unauthenticated' }, { status: 401 }) })
  expect((await POST(request())).status).toBe(401)
  mocks.publishAllowed.mockReturnValue(false)
  expect((await POST(request())).status).toBe(403)
})
test('unavailable controls fail closed', async () => {
  mocks.read.mockRejectedValue(new Error('offline'))
  expect((await GET(request())).status).toBe(503)
  mocks.change.mockRejectedValue(new Error('offline'))
  expect((await POST(request())).status).toBe(503)
})
