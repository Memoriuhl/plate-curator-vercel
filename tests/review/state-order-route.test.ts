import { beforeEach, expect, test, vi } from 'vitest'
import { PATCH } from '../../app/api/batches/[id]/plates/[plateId]/route'
import { GET } from '../../app/api/batches/[id]/route'
import { plateRevision } from '../../lib/review/revision'
import { PUT } from '../../app/api/batches/[id]/state-order/[state]/route'
import { createMemoryStore } from '../../lib/review/memory-store'
import type { ReviewDeps } from '../../lib/review/types'
import type { Plate } from '../../lib/catalog/types'

const context = vi.hoisted(() => ({ currentActor: vi.fn(), reviewDeps: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ cacheTag: vi.fn(), cacheLife: vi.fn(), revalidateTag: vi.fn() }))
vi.mock('../../lib/server/context', () => context)
const batch = { id: 'batch', name: 'Order', createdBy: 'editor', createdByName: null, createdAt: '', state: 'open' as const, revision: 4, baselineVersion: 7, plateIds: ['one'], stateOrders: {}, approval: null }
beforeEach(() => {
  context.currentActor.mockResolvedValue({ ok: true, actor: { uid: 'editor', name: null, role: 'editor' } })
  context.reviewDeps.mockReturnValue({ store: createMemoryStore([batch]), stateBaseline: async () => ['one', 'two'].map(id => ({ id, state: 'AK', slug: id, displayName: id, image: '', tags: [], templateRole: 'template' as const, isStandard: id === 'one' })), baselineAtVersion: async () => null, baseline: async () => null, now: () => '2026-11-17T16:15:00Z' } satisfies ReviewDeps)
})
function put(body: unknown) {
  return PUT(new Request('https://example.com/api/batches/batch/state-order/AK', { method: 'PUT', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'batch', state: 'AK' }) })
}
function patchPlate(plateId: string, body: unknown) {
  return PATCH(new Request(`https://example.com/api/batches/batch/plates/${plateId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: 'batch', plateId }) })
}

test('discard restores one moved plate and preserves the relative order of the other plates', async () => {
  const deps: ReviewDeps = context.reviewDeps()
  const baseline: Plate[] = ['one', 'two', 'three', 'four', 'five'].map(id => ({ id, state: 'AK', slug: id, displayName: id, image: '', tags: [], templateRole: 'template', isStandard: id === 'one' }))
  deps.stateBaseline = async () => baseline
  deps.baselineAtVersion = async (_, id) => baseline.find(plate => plate.id === id) ?? null
  expect((await put({ batchRevision: 4, order: ['one', 'three', 'two', 'five', 'four'] })).status).toBe(200)
  expect((await patchPlate('three', { batchRevision: 4, discard: 'order' })).status).toBe(409)
  const response = await patchPlate('three', { batchRevision: 5, discard: 'order' })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ revision: 6, stateOrders: { AK: ['one', 'two', 'three', 'five', 'four'] } })
})

test('clearing a replacement Standard restores the linked Standard and its order', async () => {
  const deps: ReviewDeps = context.reviewDeps()
  const baseline = await deps.stateBaseline(7, 'AK')
  deps.baselineAtVersion = async (_, id) => baseline.find(plate => plate.id === id) ?? null
  expect((await put({ batchRevision: 4, order: ['two', 'one'], standard: { from: 'one', to: 'two' } })).status).toBe(200)
  const response = await patchPlate('two', { batchRevision: 5, discard: 'all' })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ revision: 6, plateIds: ['one'], stateOrders: {} })
  expect(await deps.store.listEdits('batch')).toEqual([])
})
test('signed-in creator receives the updated batch', async () => {
  const response = await put({ batchRevision: 4, order: ['two', 'one'], standard: { from: 'one', to: 'two' } })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ...batch, lastChangedAt: '2026-11-17T16:15:00Z', plateIds: ['one', 'two'], revision: 5, stateOrders: { AK: ['two', 'one'] }, baselineOrders: { AK: ['one', 'two'] } })
})

test('combined order request promotes the Variant with one revision and rejects stale retries', async () => {
  const deps = context.reviewDeps()
  const variant = { id: 'one', state: 'AK', slug: 'one', displayName: 'One', image: '', tags: [], templateRole: 'variant' as const, templateFamily: 'old', variantOfPlateId: 'two' }
  deps.baselineAtVersion = async () => variant
  deps.stateBaseline = async () => [variant, { ...variant, id: 'two', templateRole: 'template' as const, templateFamily: 'parent' }]
  const body = { batchRevision: 4, standard: { from: null, to: 'two' }, order: ['two', 'one'], promotion: { plateId: 'one', templateFamily: 'new' } }
  expect((await put(body)).status).toBe(200)
  expect(await deps.store.getBatch('batch')).toMatchObject({ revision: 5, stateOrders: { AK: body.order } })
  expect(await deps.store.getEdit('batch', 'one')).toMatchObject({ fields: { templateRole: 'template', variantOfPlateId: null, templateFamily: 'new' } })
  expect((await put(body)).status).toBe(409)
  expect(deps.store.signalRevision('batch')).toBe(5)
})

test.each([null, {}, { plateId: 1, templateFamily: 'new' }, { plateId: 'one', templateFamily: '' }])('rejects malformed promotion %j', async promotion => {
  expect((await put({ batchRevision: 4, order: ['two', 'one'], promotion })).status).toBe(400)
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
  context.reviewDeps().baselineAtVersion = async () => baseline
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

test('detail resolves thumbnail URLs without changing reviewed plate fields', async () => {
  vi.stubEnv('PLATE_IMAGE_BASE', 'https://images.example.com')
  try {
    const baseline = { id: 'one', state: 'AK', slug: 'one', displayName: 'One', image: 'AK/one.webp', tags: [] }
    context.reviewDeps().baselineAtVersion = async () => baseline
    const response = await GET(new Request('https://example.com/api/batches/batch'), { params: Promise.resolve({ id: 'batch' }) })
    expect(await response.json()).toMatchObject({ plates: [{ baseline, proposed: baseline, beforeImageUrl: 'https://images.example.com/plates/AK/one.webp', afterImageUrl: 'https://images.example.com/plates/AK/one.webp' }] })
  } finally { vi.unstubAllEnvs() }
})

test('deletion PATCH requires authentication and rejects stale plate revisions', async () => {
  const plate = { id: 'one', state: 'AK', slug: 'one', displayName: 'One', image: 'one.png', tags: [] }
  context.reviewDeps().baselineAtVersion = async () => plate
  const patch = () => PATCH(new Request('https://example.com/api/batches/batch/plates/one', { method: 'PATCH', body: JSON.stringify({ baseRevision: plateRevision(plate), fields: { deleted: true } }) }), { params: Promise.resolve({ id: 'batch', plateId: 'one' }) })
  context.currentActor.mockResolvedValueOnce({ ok: false, response: Response.json({ error: 'unauthenticated' }, { status: 401 }) })
  expect((await patch()).status).toBe(401)
  expect((await patch()).status).toBe(200)
  expect((await patch()).status).toBe(409)
  expect(await context.reviewDeps().store.getEdit('batch', 'one')).toMatchObject({ fields: { deleted: true } })
})

test('direct PATCH cannot set story fields while local editing is disabled', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  try {
    const response = await PATCH(new Request('https://example.com/api/batches/batch/plates/one', {
      method: 'PATCH', body: JSON.stringify({ baseRevision: 'revision', fields: { funFacts: [{ text: 'A cited fact', sourceUrl: 'https://example.com/fact' }] } }),
    }), { params: Promise.resolve({ id: 'batch', plateId: 'one' }) })
    expect(response.status).toBe(400)
    expect(await context.reviewDeps().store.listEdits('batch')).toEqual([])
    expect((await context.reviewDeps().store.getBatch('batch'))!.revision).toBe(4)
  } finally { vi.unstubAllEnvs() }
})

test('the Batch endpoint pages a large response and binds continuations to one revision', async () => {
  const plateIds = Array.from({ length: 1000 }, (_, index) => 'AK.' + index)
  const draft = { ...batch, plateIds }
  const deps = context.reviewDeps()
  deps.store = createMemoryStore([draft])
  const details = 'source notes '.repeat(1800)
  deps.baselineAtVersion = async (_version: number, id: string) => ({ id, state: 'AK', slug: id, displayName: id, image: '', tags: [], details })
  const get = (page?: string) => GET(new Request('https://example.com/api/batches/batch' + (page ? '?page=' + page : '')), { params: Promise.resolve({ id: 'batch' }) })
  const first = await get()
  const body = await first.text()
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(2_010_000)
  const firstPage = JSON.parse(body)
  expect(firstPage.plates.length).toBeLessThan(100)
  expect(firstPage.plates[0].baseline.id).toBe('AK.0')
  const loaded = firstPage.plates.map((plate: { baseline: { id: string } }) => plate.baseline.id)
  let cursor = firstPage.nextPage as string | undefined
  while (cursor) {
    const page = await (await get(cursor)).text()
    expect(Buffer.byteLength(page)).toBeLessThanOrEqual(2_010_000)
    const continuation = JSON.parse(page)
    expect(continuation.batch.revision).toBe(draft.revision)
    loaded.push(...continuation.plates.map((plate: { baseline: { id: string } }) => plate.baseline.id))
    cursor = continuation.nextPage
  }
  expect(loaded).toEqual(plateIds)
  expect(await deps.store.commit(draft.id, draft.revision, { batch: { ...draft, revision: draft.revision + 1 } })).toBe('ok')
  expect((await get(firstPage.nextPage)).status).toBe(409)
})
