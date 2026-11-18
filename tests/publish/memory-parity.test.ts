import { expect, test } from 'vitest'
import { batch, command, fixture } from './fixture'
import type { PublishRecord } from '../../lib/publish/types'

test('a stale Batch read cannot erase abandonment audit on a later commit', async () => {
  const f = fixture()
  const disposition = {
    receiptId: 'batch@2--command',
    commandId: 'command',
    burnedVersion: 2,
    by: command.requestedBy,
    at: f.deps.now(),
    reason: 'Choose B',
    object: null,
  }
  await f.deps.store.updatePublishMetadata(batch.id, 2, {
    publishAbandonment: disposition,
  })
  expect(
    await f.deps.store.commit(batch.id, 2, {
      batch: { ...batch, state: 'open', revision: 3 },
    })
  ).toBe('ok')
  expect((await f.deps.store.getBatch(batch.id))?.publishAbandonment).toEqual(
    disposition
  )
})

test.each(['paused', 'revoked', 'stale_baseline'])(
  'memory eligibility and acceptance refuse %s like Firestore',
  async (reason) => {
    const f = fixture()
    if (reason === 'paused')
      f.setControl({
        paused: true,
        generation: 1,
        changedBy: { uid: 'owner', email: 'owner@example.com' },
        changedAt: f.deps.now(),
      })
    if (reason === 'revoked')
      f.setRequester({
        uid: 'owner',
        role: 'editor',
        status: 'active',
        authorityEpoch: 1,
      })
    if (reason === 'stale_baseline')
      f.deps.pointer.read = async () => ({ version: 3 })
    expect(
      await f.deps.records.eligibility(command, f.deps.now())
    ).toMatchObject({ canRetry: false, reason })
    expect(await f.deps.records.accept(command, f.deps.now())).toEqual({
      ok: false,
      error: reason,
    })
  }
)

test('memory binding refuses a claim it no longer owns', async () => {
  const f = fixture()
  await f.deps.store.updatePublishMetadata(command.batchId, command.revision, {
    publishCommand: { commandId: 'replacement', revision: command.revision },
  })
  expect(await f.deps.records.bindRun(command, 'old-run', f.deps.now())).toBe(
    false
  )
})

test('memory takeover fences the prior command and binds only the replacement run', async () => {
  const f = fixture()
  expect(await f.deps.records.accept(command, f.deps.now())).toMatchObject({
    ok: true,
  })
  f.setTime('2026-11-15T12:02:01Z')
  const fresh = { ...command, commandId: 'replacement' }
  expect(await f.deps.records.accept(fresh, f.deps.now())).toMatchObject({
    ok: true,
  })
  expect(await f.deps.records.stopped(command)).toBe('superseded')
  expect(await f.deps.records.bindRun(command, 'old-run', f.deps.now())).toBe(
    false
  )
  expect(await f.deps.records.bindRun(fresh, 'new-run', f.deps.now())).toBe(
    true
  )
  expect(await f.deps.store.getBatch(command.batchId)).toMatchObject({
    approvalRun: { runId: 'new-run' },
  })
})

test.each(['batchId', 'revision', 'toVersion'])(
  'memory adoption refuses a mismatched %s',
  async (field) => {
    const f = fixture()
    const record: PublishRecord = {
      id: 'batch@2',
      ...command,
      fromVersion: 1,
      toVersion: 2,
      blobSha256: 'bytes',
      state: 'started',
    }
    f.setControl({
      paused: true,
      generation: 1,
      changedBy: { uid: 'owner', email: 'owner@example.com' },
      changedAt: f.deps.now(),
    })
    await f.deps.control.check(command, f.deps.now())
    f.setControl({
      paused: false,
      generation: 1,
      changedBy: { uid: 'owner', email: 'owner@example.com' },
      changedAt: f.deps.now(),
    })
    f.records.set(record.id, {
      ...record,
      [field]: field === 'batchId' ? 'another' : 3,
    })
    const lease = {
      batchId: command.batchId,
      revision: command.revision,
      token: 'lease',
      expiresAt: '2026-11-15T12:01:00Z',
    }
    await f.deps.lock.claim(lease, f.deps.now())
    expect(
      await f.deps.records.adopt(
        record,
        { ...command, commandId: 'fresh' },
        'bytes',
        lease.token,
        f.deps.now()
      )
    ).toBe('version_taken')
  }
)
