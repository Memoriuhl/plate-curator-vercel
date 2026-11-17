import { beforeEach, expect, test, vi } from 'vitest'
import { createMemoryStore } from '../../lib/review/memory-store'
import { plateRevision } from '../../lib/review/revision'
import type { ReviewDeps } from '../../lib/review/types'
import type { Plate } from '../../lib/catalog/types'

const tagCache = vi.hoisted(() => {
  const entries = new Map<() => Promise<unknown>, { value: unknown; tags: Set<string> }>()
  const revalidations: unknown[][] = []
  let collecting: Set<string> | null = null
  return {
    entries,
    revalidations,
    cacheTag: (...tags: string[]) => tags.forEach(tag => collecting?.add(tag)),
    cacheLife: () => undefined,
    revalidateTag: (tag: string, profile: unknown) => {
      revalidations.push([tag, profile])
      for (const [key, entry] of entries) if (entry.tags.has(tag)) entries.delete(key)
    },
    async read<T>(fn: () => Promise<T>): Promise<T> {
      const hit = entries.get(fn)
      if (hit) return hit.value as T
      collecting = new Set()
      const pending = fn()
      const tags = collecting
      collecting = null
      const value = await pending
      entries.set(fn, { value, tags })
      return value
    },
  }
})
const firestore = vi.hoisted(() => ({ version: 14, curator: { stateOrder: {}, stateProgress: {} } as { stateOrder: Record<string, string[]>; stateProgress: Record<string, string> } }))
const mocks = vi.hoisted(() => ({ createHook: vi.fn(), publishBatch: vi.fn(), reviewDeps: vi.fn(), currentActor: vi.fn() }))

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ cacheTag: tagCache.cacheTag, cacheLife: tagCache.cacheLife, revalidateTag: tagCache.revalidateTag }))
vi.mock('workflow', () => ({ createHook: mocks.createHook, sleep: () => new Promise(() => {}), RetryableError: class extends Error {} }))
vi.mock('../../lib/publish/publish', () => ({ publishBatch: mocks.publishBatch }))
vi.mock('../../workflows/catalog-push', () => ({ catalogPush: async () => ({ status: 'disabled', sent: 0, failed: 0, pruned: 0 }) }))
vi.mock('../../lib/server/context', () => ({
  catalog: () => ({
    readVersion: async () => firestore.version,
    readCuratorState: async () => structuredClone(firestore.curator),
    imageUrl: () => '',
  }),
  currentActor: mocks.currentActor,
  reviewDeps: mocks.reviewDeps,
  publishDeps: () => ({}),
}))

const { cachedCatalogHead } = await import('../../lib/server/catalog-head')
const { approvalRun } = await import('../../workflows/approval')
const { PATCH } = await import('../../app/api/batches/[id]/plates/[plateId]/route')
const { PUT } = await import('../../app/api/batches/[id]/state-order/[state]/route')

const plate: Plate = { id: 'AK.one', state: 'AK', slug: 'one', displayName: 'One', image: '', tags: [] }
const openBatch = { id: 'batch', name: 'AK edits', createdBy: 'editor', createdByName: null, createdAt: '', state: 'open' as const, revision: 4, baselineVersion: 14, plateIds: [plate.id], stateOrders: {}, approval: null }
const approved = { state: 'approved', revision: 2, approval: { revision: 1 } }
const head = () => tagCache.read(cachedCatalogHead)

beforeEach(() => {
  vi.clearAllMocks()
  tagCache.entries.clear()
  tagCache.revalidations.length = 0
  firestore.version = 14
  firestore.curator = { stateOrder: {}, stateProgress: {} }
  mocks.currentActor.mockResolvedValue({ ok: true, actor: { uid: 'editor', name: null, role: 'editor' } })
  mocks.reviewDeps.mockReturnValue({
    store: createMemoryStore([openBatch]),
    baseline: async () => plate,
    baselineAtVersion: async () => plate,
    stateBaseline: async () => [plate, { ...plate, id: 'AK.two', slug: 'two', templateRole: 'template' }],
    now: () => '',
  } satisfies ReviewDeps)
})

test('the catalog head is served from cache until something clears its tag', async () => {
  expect((await head()).version).toBe(14)
  firestore.version = 15
  expect((await head()).version).toBe(14)
  expect(tagCache.revalidations).toEqual([])
})

test('a Publish inside the approval run makes the next catalog read fresh', async () => {
  expect((await head()).version).toBe(14)
  firestore.version = 15
  mocks.reviewDeps.mockReturnValue({ store: { getBatch: async () => approved } })
  mocks.createHook.mockResolvedValue({ ownerUid: 'owner' })
  mocks.publishBatch.mockResolvedValue({ ok: true, value: { toVersion: 15 } })
  expect(await approvalRun('batch', 1)).toEqual({ outcome: 'published', version: 15, push: { status: 'disabled', sent: 0, failed: 0, pruned: 0 } })
  expect(tagCache.revalidations).toEqual([['catalog-head', { expire: 0 }]])
  expect((await head()).version).toBe(15)
})

test('a failed Publish leaves the cached head alone', async () => {
  await head()
  mocks.reviewDeps.mockReturnValue({ store: { getBatch: async () => approved } })
  mocks.createHook.mockResolvedValue({ ownerUid: 'owner' })
  mocks.publishBatch.mockResolvedValue({ ok: false, error: 'invalid_snapshot', reasons: [] })
  expect((await approvalRun('batch', 1)).outcome).toBe('publish_failed')
  expect(tagCache.revalidations).toEqual([])
})

test('a curator plate edit makes the next catalog read fresh', async () => {
  await head()
  firestore.curator = { stateOrder: {}, stateProgress: { AK: 'done' } }
  const response = await PATCH(
    new Request('https://example.com/api/batches/batch/plates/AK.one', { method: 'PATCH', body: JSON.stringify({ baseRevision: plateRevision(plate), fields: { tags: ['gold'] } }) }),
    { params: Promise.resolve({ id: 'batch', plateId: plate.id }) },
  )
  expect(response.status).toBe(200)
  expect((await head()).curator.stateProgress).toEqual({ AK: 'done' })
})

test('a curator state reorder makes the next catalog read fresh', async () => {
  await head()
  firestore.curator = { stateOrder: { AK: ['AK.two', 'AK.one'] }, stateProgress: {} }
  const response = await PUT(
    new Request('https://example.com/api/batches/batch/state-order/AK', { method: 'PUT', body: JSON.stringify({ batchRevision: 4, order: ['AK.two', 'AK.one'], standard: { from: null, to: 'AK.two' } }) }),
    { params: Promise.resolve({ id: 'batch', state: 'AK' }) },
  )
  expect(response.status).toBe(200)
  expect((await head()).curator.stateOrder).toEqual({ AK: ['AK.two', 'AK.one'] })
})

test('a rejected curator write keeps the cached head', async () => {
  await head()
  const response = await PUT(
    new Request('https://example.com/api/batches/batch/state-order/AK', { method: 'PUT', body: JSON.stringify({ batchRevision: 3, order: ['AK.two', 'AK.one'] }) }),
    { params: Promise.resolve({ id: 'batch', state: 'AK' }) },
  )
  expect(response.status).toBe(409)
  expect(tagCache.revalidations).toEqual([])
})
