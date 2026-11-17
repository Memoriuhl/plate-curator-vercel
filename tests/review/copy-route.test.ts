import { beforeEach, expect, test, vi } from 'vitest'
import { POST } from '../../app/api/batches/[id]/copy/route'
import { GET as detail } from '../../app/api/batches/[id]/route'
import { GET as preflight } from '../../app/api/batches/[id]/publish/route'
import { createMemoryStore } from '../../lib/review/memory-store'
import { batch, owner, snapshot, fixture } from '../publish/fixture'

const mocks = vi.hoisted(() => ({ currentActor: vi.fn(), publishDeps: vi.fn(), reviewDeps: vi.fn(), reviewEnv: () => 'test' }))
vi.mock('../../lib/server/context', () => mocks)
vi.mock('../../lib/server/members', () => ({ membersStore: () => ({}) }))
const ctx = { params: Promise.resolve({ id: batch.id }) }
const request = (body: unknown) => new Request('http://localhost/api/batches/batch/copy', { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.currentActor.mockResolvedValue({ ok: true, actor: owner })
  const store = createMemoryStore([batch], () => 2)
  const deps = { ...fixture().deps, store, pointer: { read: async () => ({ version: 2 }) }, snapshots: { read: async () => ({ ...snapshot, version: 2 }) }, baselineAtVersion: async (_v: number, id: string) => snapshot.plates.find(plate => plate.id === id) ?? null }
  mocks.publishDeps.mockReturnValue(deps)
  mocks.reviewDeps.mockReturnValue(deps)
})

test('authenticated copy is readable through the normal review route and replay returns the same Batch', async () => {
  const body = { revision: 2, targetVersion: 2 }
  const response = await POST(request(body), ctx)
  expect(response.status).toBe(200)
  const copy = await response.json()
  expect(copy).toMatchObject({ state: 'open', revision: 0, approval: null, baselineVersion: 2, source: { batchId: 'batch', revision: 2 } })
  expect(await (await POST(request(body), ctx)).json()).toEqual(copy)
  const reviewed = await detail(request(null), { params: Promise.resolve({ id: copy.id }) })
  expect(reviewed.status).toBe(200)
  expect(await reviewed.json()).toMatchObject({ batch: copy, plates: [{ baseline: { id: 'one' } }] })
  expect(await (await preflight(request(null), ctx)).json()).toEqual({ error: 'stale_baseline', reviewedVersion: 1, liveVersion: 2 })
})

test('authentication and Owner checks precede reads and writes', async () => {
  mocks.currentActor.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 401 }) })
  expect((await POST(request({ revision: 2, targetVersion: 2 }), ctx)).status).toBe(401)
  mocks.currentActor.mockResolvedValue({ ok: true, actor: { ...owner, role: 'editor' } })
  expect((await POST(request({ revision: 2, targetVersion: 2 }), ctx)).status).toBe(403)
  expect((await preflight(request(null), ctx)).status).toBe(403)
  expect(mocks.publishDeps).not.toHaveBeenCalled()
})

test.each([{}, { revision: -1, targetVersion: 2 }, { revision: 2.2, targetVersion: 2 }, { revision: 2, targetVersion: '2' }])('validates copy input %j', async body => {
  expect((await POST(request(body), ctx)).status).toBe(400)
})

test('a moved head is explicit and never silently retargets', async () => {
  const response = await POST(request({ revision: 2, targetVersion: 1 }), ctx)
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: 'head_moved', liveVersion: 2 })
  expect(await mocks.reviewDeps().store.list({})).toHaveLength(1)
})

test.each(['head', 'snapshot'])('copy returns structured unavailable when the %s read fails', async failure => {
  const deps = mocks.publishDeps()
  if (failure === 'head') deps.pointer.read = async () => { throw new Error('head unavailable') }
  else deps.snapshots.read = async () => { throw new Error('snapshot unavailable') }
  const response = await POST(request({ revision: 2, targetVersion: 2 }), ctx)
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ ok: false, error: 'unavailable' })
  expect(await deps.store.list({})).toHaveLength(1)
})
