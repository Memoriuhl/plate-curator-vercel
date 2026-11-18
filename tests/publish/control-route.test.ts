import { beforeEach, expect, test, vi } from 'vitest'
import { GET, POST } from '../../app/api/publish/control/route'

const control = {
  paused: false,
  generation: 1,
  changedBy: { uid: 'owner', email: 'owner@example.com' },
  changedAt: '2026-11-16T12:00:00Z',
}
const mocks = vi.hoisted(() => ({
  currentActiveOwner: vi.fn(),
  publishAllowed: vi.fn(),
  publishControl: vi.fn(),
  read: vi.fn(),
  change: vi.fn(),
}))
vi.mock('../../lib/server/context', () => mocks)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.currentActiveOwner.mockResolvedValue({
    ok: true,
    actor: { uid: 'owner', email: 'owner@example.com', role: 'owner' },
  })
  mocks.publishAllowed.mockReturnValue(true)
  mocks.publishControl.mockReturnValue({
    read: mocks.read,
    change: mocks.change,
  })
  mocks.read.mockResolvedValue(control)
  mocks.change.mockResolvedValue({ ...control, paused: true, generation: 2 })
})
/** Build the POST request the route fixture passes to its handler. */
const request = (paused = true) =>
  new Request('http://localhost/api/publish/control', {
    method: 'POST',
    body: JSON.stringify({ paused }),
  })

test('Owner can read audit details and pause or resume', async () => {
  expect(await (await GET(request())).json()).toEqual({
    control,
    enabledHere: true,
  })
  for (const paused of [true, false]) {
    expect((await POST(request(paused))).status).toBe(200)
    expect(mocks.change).toHaveBeenLastCalledWith(
      paused,
      control.changedBy,
      expect.any(String)
    )
  }
})
test.each(['editor', 'removed', 'bootstrap'])(
  'current membership denies %s',
  async () => {
    mocks.currentActiveOwner.mockResolvedValue({
      ok: false,
      response: Response.json({ error: 'forbidden' }, { status: 403 }),
    })
    expect((await POST(request())).status).toBe(403)
    expect(mocks.change).not.toHaveBeenCalled()
  }
)
test('unauthenticated requests and disabled environments are denied', async () => {
  mocks.currentActiveOwner.mockResolvedValueOnce({
    ok: false,
    response: Response.json({ error: 'unauthenticated' }, { status: 401 }),
  })
  expect((await POST(request())).status).toBe(401)
  mocks.publishAllowed.mockReturnValue(false)
  expect(await (await GET(request())).json()).toEqual({
    control,
    enabledHere: false,
  })
  expect((await POST(request())).status).toBe(403)
})
test('unavailable controls fail closed', async () => {
  mocks.read.mockRejectedValue(new Error('offline'))
  expect((await GET(request())).status).toBe(503)
  mocks.change.mockRejectedValue(new Error('offline'))
  expect((await POST(request())).status).toBe(503)
})

test('Pause without an initialized control reports not enabled instead of forbidden', async () => {
  mocks.change.mockResolvedValue('publish_not_enabled')
  const response = await POST(request())
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: 'publish_not_enabled' })
})

test('GET requires authentication', async () => {
  mocks.currentActiveOwner.mockResolvedValueOnce({
    ok: false,
    response: Response.json({ error: 'unauthenticated' }, { status: 401 }),
  })
  expect((await GET(request())).status).toBe(401)
  expect(mocks.read).not.toHaveBeenCalled()
})
