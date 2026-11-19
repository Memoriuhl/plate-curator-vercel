import { beforeEach, expect, test, vi } from 'vitest'
import { POST } from '../../app/api/batches/[id]/review-checkpoint/route'
import { createMemoryStore } from '../../lib/review/memory-store'
import type { ReviewBatch } from '../../lib/review/types'

const context = vi.hoisted(() => ({
  currentActiveOwner: vi.fn(),
  reviewDeps: vi.fn(),
  reviewEnv: () => 'test',
}))
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
  revalidateTag: vi.fn(),
}))
vi.mock('../../lib/server/context', () => context)

const draft: ReviewBatch = {
  id: 'batch',
  kind: 'shared-draft',
  name: 'Shared draft',
  createdBy: 'owner',
  createdByName: null,
  createdAt: '',
  state: 'open',
  revision: 4,
  baselineVersion: 7,
  plateIds: [],
  stateOrders: {},
  approval: null,
}

/** Serve one stored batch and watch whether a checkpoint is written for it. */
function serve(batch: ReviewBatch) {
  const store = createMemoryStore([batch])
  const markViewed = vi.spyOn(store, 'markViewed')
  context.reviewDeps.mockReturnValue({
    store,
    baseline: async () => null,
    baselineAtVersion: async () => null,
    stateBaseline: async () => [],
    now: () => '2026-11-18T12:00:00Z',
  })
  return markViewed
}

/** Record that the Owner viewed a revision of the fixture batch. */
const post = (revision: number) =>
  POST(
    new Request('https://example.com/api/batches/batch/review-checkpoint', {
      method: 'POST',
      body: JSON.stringify({ revision }),
    }),
    { params: Promise.resolve({ id: 'batch' }) }
  )

beforeEach(() => {
  context.currentActiveOwner.mockResolvedValue({
    ok: true,
    actor: {
      uid: 'owner',
      name: null,
      role: 'owner',
      email: 'owner@example.com',
      authorityEpoch: 0,
    },
  })
})

test('a checkpoint on the shared draft is recorded', async () => {
  const markViewed = serve(draft)
  const response = await post(4)
  expect(response.status).toBe(200)
  expect(markViewed).toHaveBeenCalledOnce()
})

test('a checkpoint sent to a published history Batch answers 409 and writes nothing', async () => {
  const history: ReviewBatch = { ...draft, state: 'published' }
  delete history.kind
  const markViewed = serve(history)
  const response = await post(4)
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: 'history_read_only' })
  expect(markViewed).not.toHaveBeenCalled()
})
