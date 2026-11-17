import { beforeEach, expect, test, vi } from 'vitest'
import { approvalRun } from '../../workflows/approval'

const mocks = vi.hoisted(() => ({ getBatch: vi.fn(), createHook: vi.fn(), publishBatch: vi.fn(), publishDeps: vi.fn(() => ({})), catalogPush: vi.fn() }))
vi.mock('../../workflows/catalog-push', () => ({ catalogPush: mocks.catalogPush }))
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ cacheTag: vi.fn(), cacheLife: vi.fn(), revalidateTag: vi.fn() }))
vi.mock('workflow', () => ({ createHook: mocks.createHook, sleep: () => new Promise(() => {}), RetryableError: class extends Error {} }))
vi.mock('../../lib/server/context', () => ({ reviewDeps: () => ({ store: { getBatch: mocks.getBatch } }), publishDeps: mocks.publishDeps }))
vi.mock('../../lib/publish/publish', () => ({ publishBatch: mocks.publishBatch }))

const approved = { state: 'approved', revision: 2, approval: { revision: 1 } }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.getBatch.mockResolvedValue(approved)
  mocks.publishBatch.mockResolvedValue({ ok: true, value: { toVersion: 8 } })
  mocks.catalogPush.mockResolvedValue({ status: 'unavailable', sent: 0, failed: 0, pruned: 0 })
})
test('a superseded approval exits without Publish', async () => {
  mocks.getBatch.mockResolvedValueOnce({ state: 'submitted', revision: 1 })
  mocks.createHook.mockResolvedValue({ superseded: true })
  expect(await approvalRun('batch', 1)).toEqual({ outcome: 'superseded' })
  expect(mocks.publishBatch).not.toHaveBeenCalled()
})
test('a superseded Publish command exits without Publish', async () => {
  mocks.createHook.mockResolvedValue({ superseded: true })
  expect(await approvalRun('batch', 1)).toEqual({ outcome: 'superseded' })
  expect(mocks.publishBatch).not.toHaveBeenCalled()
})
test('an edit during the transition to the Publish wait supersedes the run', async () => {
  mocks.getBatch.mockResolvedValueOnce(approved).mockResolvedValueOnce(approved).mockResolvedValueOnce({ state: 'open', revision: 3 })
  mocks.createHook.mockResolvedValue({ ownerUid: 'owner' })
  expect(await approvalRun('batch', 1)).toEqual({ outcome: 'superseded' })
  expect(mocks.publishBatch).not.toHaveBeenCalled()
})
test('a stale run cannot Publish after its command arrives', async () => {
  mocks.getBatch.mockResolvedValueOnce(approved).mockResolvedValueOnce(approved).mockResolvedValueOnce(approved).mockResolvedValueOnce({ state: 'open', revision: 3 })
  mocks.createHook.mockResolvedValue({ ownerUid: 'owner' })
  expect(await approvalRun('batch', 1)).toEqual({ outcome: 'superseded' })
  expect(mocks.publishBatch).not.toHaveBeenCalled()
})
test('an approved command publishes inside the run and returns the version', async () => {
  mocks.createHook.mockResolvedValue({ ownerUid: 'owner' })
  expect(await approvalRun('batch', 1)).toEqual({ outcome: 'published', version: 8, push: { status: 'unavailable', sent: 0, failed: 0, pruned: 0 } })
  expect(mocks.catalogPush).toHaveBeenCalledExactlyOnceWith(8)
  expect(mocks.publishBatch).toHaveBeenCalledWith({}, { uid: 'owner', name: null, role: 'owner' }, { batchId: 'batch', revision: 2 })
})

test('the step exposes both versions if the Catalog changed after accepting Publish', async () => {
  mocks.createHook.mockResolvedValue({ ownerUid: 'owner' })
  mocks.publishBatch.mockResolvedValue({ ok: false, error: 'stale_baseline', reviewedVersion: 7, liveVersion: 8 })
  expect(await approvalRun('batch', 1)).toEqual({ outcome: 'publish_failed', error: 'stale_baseline', reasons: [], reviewedVersion: 7, liveVersion: 8 })
  expect(mocks.catalogPush).not.toHaveBeenCalled()
})

test('failed Publish sends no push', async () => {
  mocks.createHook.mockResolvedValue({ ownerUid: 'owner' })
  mocks.publishBatch.mockResolvedValue({ ok: false, error: 'invalid_snapshot' })
  expect(await approvalRun('batch', 1)).toMatchObject({ outcome: 'publish_failed' })
  expect(mocks.catalogPush).not.toHaveBeenCalled()
})
