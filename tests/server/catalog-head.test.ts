import { beforeEach, expect, test, vi } from 'vitest'
import { createMemoryStore } from '../../lib/review/memory-store'
import { plateRevision } from '../../lib/review/revision'
import type { ReviewDeps } from '../../lib/review/types'
import type { Plate } from '../../lib/catalog/types'

const tagCache = vi.hoisted(() => {
  const entries = new Map<
    () => Promise<unknown>,
    { value: unknown; tags: Set<string> }
  >()
  const revalidations: unknown[][] = []
  let collecting: Set<string> | null = null
  return {
    entries,
    revalidations,
    /** Record the tags appended by the active cached catalog read. */
    cacheTag: (...tags: string[]) =>
      tags.forEach((tag) => collecting?.add(tag)),
    /**
     * Accept the cache lifetime call without scheduling real Next.js cache expiration.
     */
    cacheLife: () => undefined,
    /** Record each invalidation and evict fixture cache entries bearing its tag. */
    revalidateTag: (tag: string, profile: unknown) => {
      revalidations.push([tag, profile])
      for (const [key, entry] of entries)
        if (entry.tags.has(tag)) entries.delete(key)
    },
    /**
     * Return a cached value or record the new result with the tags collected during its
     * load.
     */
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
const firestore = vi.hoisted(() => ({
  version: 14,
  curator: { stateOrder: {}, stateProgress: {} } as {
    stateOrder: Record<string, string[]>
    stateProgress: Record<string, string>
  },
}))
const mocks = vi.hoisted(() => ({
  createHook: vi.fn(),
  publishBatch: vi.fn(),
  reviewDeps: vi.fn(),
  currentActor: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({
  cacheTag: tagCache.cacheTag,
  cacheLife: tagCache.cacheLife,
  revalidateTag: tagCache.revalidateTag,
}))
vi.mock('workflow', () => ({
  createHook: mocks.createHook,
  /** Control polling time through the fixture instead of waiting for a real interval. */ sleep:
    () => new Promise(() => {}),
  RetryableError: class extends Error {},
}))
vi.mock('../../lib/publish/publish', () => ({
  publishBatch: mocks.publishBatch,
}))
vi.mock('../../workflows/catalog-push', () => ({
  /** Simulate disabled catalog notifications so publishing can focus on cache invalidation. */ catalogPush:
    async () => ({ status: 'disabled', sent: 0, failed: 0, pruned: 0 }),
}))
vi.mock('../../lib/server/context', () => ({
  /**
   * Expose the fixture catalog's current version and curator metadata through the server
   * source interface.
   */
  catalog: () => ({
    /** Read the live version from the observable fixture pointer. */
    readVersion: async () => firestore.version,
    /** Return a detached copy of the fixture curator metadata for the cached head. */
    readCuratorState: async () => structuredClone(firestore.curator),
    /** Leave image URLs empty because the fixture exercises catalog version and order. */
    imageUrl: () => '',
  }),
  currentActor: mocks.currentActor,
  reviewDeps: mocks.reviewDeps,
  /**
   * Stub release dependencies because the workflow's publish operation is replaced by
   * the test.
   */
  publishDeps: () => ({}),
}))

const { cachedCatalogHead } = await import('../../lib/server/catalog-head')
const { publishRun } = await import('../../workflows/approval')
const { PATCH } =
  await import('../../app/api/batches/[id]/plates/[plateId]/route')
const { PUT } =
  await import('../../app/api/batches/[id]/state-order/[state]/route')

const plate: Plate = {
  id: 'AK.one',
  state: 'AK',
  slug: 'one',
  displayName: 'One',
  image: '',
  tags: [],
}
const openBatch = {
  id: 'batch',
  kind: 'shared-draft' as const,
  name: 'AK edits',
  createdBy: 'editor',
  createdByName: null,
  createdAt: '',
  state: 'open' as const,
  revision: 4,
  baselineVersion: 14,
  plateIds: [plate.id],
  stateOrders: {},
  approval: null,
}
const approved = { state: 'approved', revision: 2, approval: { revision: 1 } }
/** Expose the current fixture catalog version so the operation can check its baseline. */
const head = () => tagCache.read(cachedCatalogHead)

beforeEach(() => {
  vi.clearAllMocks()
  tagCache.entries.clear()
  tagCache.revalidations.length = 0
  firestore.version = 14
  firestore.curator = { stateOrder: {}, stateProgress: {} }
  mocks.currentActor.mockResolvedValue({
    ok: true,
    actor: { uid: 'editor', name: null, role: 'editor' },
  })
  mocks.reviewDeps.mockReturnValue({
    store: createMemoryStore([openBatch]),
    /** Supply the test plate as the catalog baseline. */
    baseline: async () => plate,
    /** Supply the test plate as the catalog baseline. */
    baselineAtVersion: async () => plate,
    /** Return the fixture state order used by the review or queue operation. */
    stateBaseline: async () => [
      plate,
      { ...plate, id: 'AK.two', slug: 'two', templateRole: 'template' },
    ],
    /** Use an empty timestamp where the scenario does not depend on dates. */
    now: () => '',
  } satisfies ReviewDeps)
})

test('the catalog head is served from cache until something clears its tag', async () => {
  expect((await head()).version).toBe(14)
  firestore.version = 15
  expect((await head()).version).toBe(14)
  expect(tagCache.revalidations).toEqual([])
})

test('a Publish run makes the next catalog read fresh', async () => {
  expect((await head()).version).toBe(14)
  firestore.version = 15
  mocks.reviewDeps.mockReturnValue({
    store: {
      /** Return controlled batch data so the test can exercise the review state. */ getBatch:
        async () => approved,
      /** An older Batch has no shared draft to rebase. */ readBatch:
        async () => null,
    },
  })
  mocks.publishBatch.mockResolvedValue({ ok: true, value: { toVersion: 15 } })
  expect(await publishRun('batch', 2, { ownerUid: 'owner' })).toEqual({
    outcome: 'published',
    version: 15,
    rebased: true,
    push: { status: 'disabled', sent: 0, failed: 0, pruned: 0 },
  })
  expect(tagCache.revalidations).toEqual([['catalog-head', { expire: 0 }]])
  expect((await head()).version).toBe(15)
})

test('a failed Publish leaves the cached head alone', async () => {
  await head()
  mocks.reviewDeps.mockReturnValue({
    store: {
      /** Return controlled batch data so the test can exercise the review state. */ getBatch:
        async () => approved,
    },
  })
  mocks.publishBatch.mockResolvedValue({
    ok: false,
    error: 'invalid_snapshot',
    reasons: [],
  })
  expect((await publishRun('batch', 2, { ownerUid: 'owner' })).outcome).toBe(
    'publish_failed'
  )
  expect(tagCache.revalidations).toEqual([])
})

test('a curator plate edit makes the next catalog read fresh', async () => {
  await head()
  firestore.curator = { stateOrder: {}, stateProgress: { AK: 'done' } }
  const response = await PATCH(
    new Request('https://example.com/api/batches/batch/plates/AK.one', {
      method: 'PATCH',
      body: JSON.stringify({
        baseRevision: plateRevision(plate),
        fields: { tags: ['gold'] },
      }),
    }),
    { params: Promise.resolve({ id: 'batch', plateId: plate.id }) }
  )
  expect(response.status).toBe(200)
  expect((await head()).curator.stateProgress).toEqual({ AK: 'done' })
})

test('a curator state reorder makes the next catalog read fresh', async () => {
  await head()
  firestore.curator = {
    stateOrder: { AK: ['AK.two', 'AK.one'] },
    stateProgress: {},
  }
  const response = await PUT(
    new Request('https://example.com/api/batches/batch/state-order/AK', {
      method: 'PUT',
      body: JSON.stringify({
        batchRevision: 4,
        order: ['AK.two', 'AK.one'],
        standard: { from: null, to: 'AK.two' },
      }),
    }),
    { params: Promise.resolve({ id: 'batch', state: 'AK' }) }
  )
  expect(response.status).toBe(200)
  expect((await head()).curator.stateOrder).toEqual({
    AK: ['AK.two', 'AK.one'],
  })
})

test('a rejected curator write keeps the cached head', async () => {
  await head()
  const response = await PUT(
    new Request('https://example.com/api/batches/batch/state-order/AK', {
      method: 'PUT',
      body: JSON.stringify({ batchRevision: 3, order: ['AK.two', 'AK.one'] }),
    }),
    { params: Promise.resolve({ id: 'batch', state: 'AK' }) }
  )
  expect(response.status).toBe(409)
  expect(tagCache.revalidations).toEqual([])
})
