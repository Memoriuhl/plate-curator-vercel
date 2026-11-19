import { beforeEach, expect, test, vi } from 'vitest'
import { publishRun } from '../../workflows/approval'

const mocks = vi.hoisted(() => ({
  getBatch: vi.fn(),
  publishBatch: vi.fn(),
  publishDeps: vi.fn(() => ({})),
  catalogPush: vi.fn(),
  afterPublish: vi.fn(),
}))
vi.mock('../../workflows/catalog-push', () => ({
  catalogPush: mocks.catalogPush,
}))
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
  revalidateTag: vi.fn(),
}))
vi.mock('workflow', () => ({
  RetryableError: class extends Error {},
}))
vi.mock('../../lib/server/context', () => ({
  /** Supply isolated review dependencies to the route or workflow under test. */ reviewDeps:
    () => ({ store: { getBatch: mocks.getBatch } }),
  publishDeps: mocks.publishDeps,
}))
vi.mock('../../lib/publish/publish', () => ({
  publishBatch: mocks.publishBatch,
}))
vi.mock('../../lib/review/draft', () => ({
  afterPublish: mocks.afterPublish,
}))

const approved = { state: 'approved', revision: 2, approval: { revision: 1 } }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.getBatch.mockResolvedValue(approved)
  mocks.afterPublish.mockResolvedValue({ ok: false, error: 'not_found' })
  mocks.publishBatch.mockResolvedValue({ ok: true, value: { toVersion: 8 } })
  mocks.catalogPush.mockResolvedValue({
    status: 'unavailable',
    sent: 0,
    failed: 0,
    pruned: 0,
  })
})
test('an approved command publishes inside the run and returns the version', async () => {
  const command = { ownerUid: 'owner' }
  expect(await publishRun('batch', 2, command)).toEqual({
    outcome: 'published',
    version: 8,
    rebased: true,
    push: { status: 'unavailable', sent: 0, failed: 0, pruned: 0 },
  })
  expect(mocks.catalogPush).toHaveBeenCalledExactlyOnceWith(8)
  expect(mocks.publishBatch).toHaveBeenCalledWith(
    {},
    { uid: 'owner', name: null, role: 'owner' },
    { batchId: 'batch', revision: 2 }
  )
})

test('the step exposes both versions if the Catalog changed after accepting Publish', async () => {
  const command = { ownerUid: 'owner' }
  mocks.publishBatch.mockResolvedValue({
    ok: false,
    error: 'stale_baseline',
    reviewedVersion: 7,
    liveVersion: 8,
  })
  expect(await publishRun('batch', 2, command)).toEqual({
    outcome: 'publish_failed',
    error: 'stale_baseline',
    reasons: [],
    reviewedVersion: 7,
    liveVersion: 8,
  })
  expect(mocks.catalogPush).not.toHaveBeenCalled()
})

test('failed Publish sends no push', async () => {
  const command = { ownerUid: 'owner' }
  mocks.publishBatch.mockResolvedValue({ ok: false, error: 'invalid_snapshot' })
  expect(await publishRun('batch', 2, command)).toMatchObject({
    outcome: 'publish_failed',
  })
  expect(mocks.catalogPush).not.toHaveBeenCalled()
})

test.each(['paused', 'revoked', 'superseded', 'publish_not_enabled'])(
  'a generation-bound command returns terminal %s without retrying',
  async (error) => {
    const command = {
      ownerUid: 'owner',
      generation: 3,
      commandId: 'fresh-command',
    }
    mocks.publishBatch.mockResolvedValue({ ok: false, error })
    expect(await publishRun('batch', 2, command)).toEqual({
      outcome: 'publish_failed',
      error,
      reasons: [],
    })
    expect(mocks.publishBatch).toHaveBeenCalledWith(
      {},
      { uid: 'owner', name: null, role: 'owner' },
      {
        batchId: 'batch',
        revision: 2,
        generation: 3,
        commandId: 'fresh-command',
      }
    )
    expect(mocks.publishBatch).toHaveBeenCalledTimes(1)
    expect(mocks.catalogPush).not.toHaveBeenCalled()
  }
)

test('paused and superseded Publish stops never reach catalogPush', async () => {
  const command = {
    ownerUid: 'owner',
    generation: 3,
    commandId: 'stopped-command',
  }
  for (const error of ['paused', 'revoked', 'superseded']) {
    mocks.publishBatch.mockResolvedValue({ ok: false, error })
    expect(await publishRun('batch', 2, command)).toEqual({
      outcome: 'publish_failed',
      error,
      reasons: [],
    })
    expect(mocks.catalogPush).not.toHaveBeenCalled()
  }
})

test('requester authority passes unchanged into the publisher and revoked result', async () => {
  const requestedBy = {
    uid: 'requester',
    email: 'requester@example.com',
    authorityEpoch: 7,
  }
  const command = {
    ownerUid: 'requester',
    requestedBy,
    generation: 3,
    commandId: 'request',
  }
  mocks.publishBatch.mockResolvedValue({ ok: false, error: 'revoked' })
  expect(await publishRun('batch', 2, command)).toEqual({
    outcome: 'publish_failed',
    error: 'revoked',
    reasons: [],
    requestedBy,
  })
  expect(mocks.publishBatch).toHaveBeenCalledWith(
    {},
    { uid: 'requester', name: null, role: 'owner' },
    {
      batchId: 'batch',
      revision: 2,
      requestedBy,
      generation: 3,
      commandId: 'request',
    }
  )
  expect(mocks.catalogPush).not.toHaveBeenCalled()
})

test('dedicated fresh-command run needs no hook and only a committed outcome reaches Catalog push', async () => {
  const command = {
    ownerUid: 'backup',
    generation: 3,
    commandId: 'fresh',
    requestedBy: {
      uid: 'backup',
      email: 'backup@example.com',
      authorityEpoch: 0,
    },
  }
  for (const error of [
    'paused',
    'revoked',
    'superseded',
    'stale_baseline',
    'version_taken',
  ]) {
    mocks.publishBatch.mockResolvedValueOnce({ ok: false, error })
    expect(await publishRun('batch', 2, command)).toMatchObject({
      outcome: 'publish_failed',
      error,
      requestedBy: command.requestedBy,
    })
    expect(mocks.catalogPush).not.toHaveBeenCalled()
  }
  expect(await publishRun('batch', 2, command)).toMatchObject({
    outcome: 'published',
    version: 8,
  })
  expect(mocks.catalogPush).toHaveBeenCalledExactlyOnceWith(8)
})

test('a published release rebases the shared draft onto the new version', async () => {
  mocks.afterPublish.mockResolvedValue({ ok: true })
  expect(await publishRun('release', 2, { ownerUid: 'owner' })).toMatchObject({
    outcome: 'published',
    version: 8,
    rebased: true,
  })
  expect(mocks.afterPublish).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    'release',
    8
  )
})

test('a failed draft rebase never fails the publish', async () => {
  mocks.afterPublish.mockRejectedValue(new Error('unavailable'))
  expect(await publishRun('release', 2, { ownerUid: 'owner' })).toMatchObject({
    outcome: 'published',
    version: 8,
    rebased: false,
  })
  expect(mocks.catalogPush).toHaveBeenCalledExactlyOnceWith(8)
})

test('a failed Publish never rebases the draft', async () => {
  mocks.publishBatch.mockResolvedValue({ ok: false, error: 'invalid_snapshot' })
  await publishRun('release', 2, { ownerUid: 'owner' })
  expect(mocks.afterPublish).not.toHaveBeenCalled()
})
