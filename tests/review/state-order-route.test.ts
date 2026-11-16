import { beforeEach, expect, test, vi } from 'vitest'
import { PATCH } from '../../app/api/batches/[id]/plates/[plateId]/route'
import { GET } from '../../app/api/batches/[id]/route'
import { plateRevision } from '../../lib/review/revision'
import { PUT } from '../../app/api/batches/[id]/state-order/[state]/route'
import { createMemoryStore } from '../../lib/review/memory-store'
import type { ReviewDeps } from '../../lib/review/types'

const context = vi.hoisted(() => ({ currentActor: vi.fn(), reviewDeps: vi.fn() }))
vi.mock('../../lib/server/context', () => context)
const batch = { id: 'batch', name: 'Order', createdBy: 'editor', createdByName: null, createdAt: '', state: 'open' as const, revision: 4, baselineVersion: 7, plateIds: ['one'], stateOrders: {}, approval: null }
beforeEach(() => {
  context.currentActor.mockResolvedValue({ ok: true, actor: { uid: 'editor', name: null, role: 'editor' } })
  context.reviewDeps.mockReturnValue({ store: createMemoryStore([batch]), stateBaseline: async () => ['one', 'two'].map(id => ({ id, state: 'AK', slug: id, displayName: id, image: '', tags: [] })), baseline: async () => null, now: () => '' } satisfies ReviewDeps)
})
function put(body: unknown) {
  return PUT(new Request('https://example.com/api/batches/batch/state-order/AK', { method: 'PUT', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'batch', state: 'AK' }) })
}
test('signed-in creator receives the updated batch', async () => {
  const response = await put({ batchRevision: 4, order: ['two', 'one'] })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ...batch, revision: 5, stateOrders: { AK: ['two', 'one'] } })
})
test('requires sign-in before parsing input', async () => {
  context.currentActor.mockResolvedValue({ ok: false, response: Response.json({ error: 'unauthenticated' }, { status: 401 }) })
  expect((await put(null)).status).toBe(401)
})
test.each([null, {}, { batchRevision: -1, order: [] }, { batchRevision: 1.5, order: [] }, { batchRevision: '4', order: [] }, { batchRevision: 4, order: [1] }, { batchRevision: 4, order: 'one' }])('rejects malformed input %j', async body => {
  expect((await put(body)).status).toBe(400)
})
test('returns conflict for stale revisions and unprocessable for non-permutations', async () => {
  const stale = await put({ batchRevision: 3, order: ['two', 'one'] })
  expect(stale.status).toBe(409)
  expect(await stale.json()).toEqual({ error: 'superseded_revision' })
  expect((await put({ batchRevision: 4, order: ['one', 'one'] })).status).toBe(422)
})
test('returns forbidden and missing batch statuses', async () => {
  context.currentActor.mockResolvedValue({ ok: true, actor: { uid: 'other', role: 'editor', name: null } })
  expect((await put({ batchRevision: 4, order: ['one', 'two'] })).status).toBe(403)
  context.reviewDeps().store = createMemoryStore([])
  expect((await put({ batchRevision: 4, order: ['one', 'two'] })).status).toBe(404)
})

test('PATCH persists a null variant link and detail exposes the detached template', async () => {
  const baseline = { id: 'one', state: 'AK', slug: 'one', displayName: 'One', image: '', tags: [], templateRole: 'variant' as const, templateFamily: 'family', variantOfPlateId: 'parent' }
  context.reviewDeps().baseline = async () => baseline
  const fields = { templateRole: 'template', variantOfPlateId: null, templateFamily: 'one' }
  const response = await PATCH(new Request('https://example.com/api/batches/batch/plates/one', {
    method: 'PATCH', body: JSON.stringify({ baseRevision: plateRevision(baseline), fields }),
  }), { params: Promise.resolve({ id: 'batch', plateId: 'one' }) })
  expect(response.status).toBe(200)
  const saved = await response.json()
  expect(saved).toMatchObject({ batch: { revision: 5 }, plate: fields })
  const detail = await GET(new Request('https://example.com/api/batches/batch'), { params: Promise.resolve({ id: 'batch' }) })
  expect(await detail.json()).toMatchObject({ plates: [{ proposed: fields, edit: { fields }, revision: plateRevision(saved.plate) }] })
})
