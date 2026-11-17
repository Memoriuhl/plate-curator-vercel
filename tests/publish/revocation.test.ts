import { expect, test, vi } from 'vitest'
import { publishBatch } from '../../lib/publish/publish'
import { batch, command, fixture, owner } from './fixture'

test('revoked before preparation does not upload', async () => {
  const f = fixture()
  f.setRequester(null)
  expect(await publishBatch(f.deps, owner, command)).toEqual({ ok: false, error: 'revoked' })
  expect([...f.blobs.keys()]).toEqual([1])
  expect(f.lease()).toBeNull()
})
test.each([false, true])('revoke after upload and restore before commit: %s', async restore => {
  const f = fixture()
  const advance = f.deps.pointer.advance
  f.deps.pointer.advance = async (...args) => {
    f.setRequester(restore ? { uid: 'owner', role: 'owner', status: 'active', authorityEpoch: 2 } : null)
    return advance(...args)
  }
  expect(await publishBatch(f.deps, owner, command)).toEqual({ ok: false, error: 'revoked' })
  expect(f.pointer().version).toBe(1)
  expect(f.records.get('batch@2')).toMatchObject({ state: 'uploaded', requestedBy: command.requestedBy })
  f.setRequester({ uid: 'owner', role: 'owner', status: 'active', authorityEpoch: 2 })
  expect(await publishBatch(f.deps, owner, command)).toEqual({ ok: false, error: 'revoked' })
  expect(await f.deps.store.getBatch(batch.id)).toEqual(batch)
})
test('revoked after commit reconciles once', async () => {
  const f = fixture()
  const advance = f.deps.pointer.advance
  const spy = vi.fn(async (...args: Parameters<typeof advance>) => {
    await advance(...args)
    f.setRequester(null)
    throw new Error('lost response')
  })
  f.deps.pointer.advance = spy
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ error: 'unavailable' })
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true, value: { toVersion: 2 } })
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  expect(spy).toHaveBeenCalledTimes(1)
})
test('revoking a different approver preserves approval and permits Publish', async () => {
  const f = fixture({ ...batch, approval: { revision: 1, by: 'revoked-approver', at: '' } })
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  expect((await f.deps.store.getBatch(batch.id))?.approval?.by).toBe('revoked-approver')
})
test('missing command authority is superseded', async () => {
  const f = fixture()
  expect(await publishBatch(f.deps, owner, { ...command, requestedBy: undefined })).toEqual({ ok: false, error: 'superseded' })
})
test.each(['pause', 'revoke'])('first durable stop stays terminal when %s wins', async first => {
  const f = fixture()
  if (first === 'revoke') f.setRequester(null)
  else f.setControl({ paused: true, generation: 2, changedBy: { uid: 'other', email: 'other@example.com' }, changedAt: '2026-11-16T12:00:00Z' })
  const expected = { ok: false, error: first === 'revoke' ? 'revoked' : 'paused' }
  expect(await publishBatch(f.deps, owner, command)).toEqual(expected)
  f.setRequester(null)
  f.setControl({ paused: true, generation: 2, changedBy: { uid: 'other', email: 'other@example.com' }, changedAt: '2026-11-16T12:00:00Z' })
  expect(await publishBatch(f.deps, owner, command)).toEqual(expected)
})

test('legacy authority is superseded even when publishing is paused', async () => {
  const f = fixture()
  f.setControl({ paused: true, generation: 1, changedBy: { uid: 'other', email: 'other@example.com' }, changedAt: '2026-11-16T12:00:00Z' })
  const { requestedBy, ...legacy } = command
  expect(requestedBy).toBeDefined()
  expect(await publishBatch(f.deps, owner, legacy)).toEqual({ ok: false, error: 'superseded' })
})
