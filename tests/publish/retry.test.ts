import { expect, test, vi } from 'vitest'
import { publishBatch } from '../../lib/publish/publish'
import { command, fixture, owner } from './fixture'

const enabled = { paused: false, generation: 3, changedBy: { uid: 'owner', email: 'owner@example.com' }, changedAt: '2026-11-16T12:00:00Z' }

test.each(['pause', 'revoke'])('fresh click reuses stopped uploaded bytes after %s exactly once', async reason => {
  const f = fixture()
  const upload = vi.fn(f.deps.snapshots.createOnly)
  f.deps.snapshots.createOnly = async (...args) => {
    const result = await upload(...args)
    if (reason === 'pause') f.setControl({ ...enabled, paused: true, generation: 2 })
    else f.setRequester({ uid: 'owner', role: 'editor', status: 'active', authorityEpoch: 1 })
    return result
  }
  expect(await publishBatch(f.deps, owner, command)).toEqual({ ok: false, error: reason === 'pause' ? 'paused' : 'revoked' })
  expect(f.records.get('batch@2')).toMatchObject({ state: 'uploaded', commandId: command.commandId })
  expect(f.pointer().version).toBe(1)
  const bytes = f.blobs.get(2)
  f.setControl(enabled)
  f.setRequester({ uid: 'owner', role: 'owner', status: 'active', authorityEpoch: 2 })
  const fresh = { ...command, commandId: 'fresh', generation: 3, requestedBy: { ...command.requestedBy, authorityEpoch: 2 } }
  expect(await publishBatch(f.deps, owner, fresh)).toMatchObject({ ok: true, value: { commandId: 'fresh', toVersion: 2, supersededCommands: [expect.objectContaining({ commandId: command.commandId })] } })
  expect(await publishBatch(f.deps, owner, command)).toEqual({ ok: false, error: 'superseded' })
  expect(await publishBatch(f.deps, owner, fresh)).toMatchObject({ ok: true, value: { toVersion: 2 } })
  expect(f.blobs.get(2)).toBe(bytes)
  expect(upload).toHaveBeenCalledTimes(1)
  expect(f.pointer().version).toBe(2)
})

test.each(['checksum', 'missing', 'moved', 'unstopped'])('receipt adoption refuses %s without uploading again', async kind => {
  const f = fixture()
  const upload = vi.fn(f.deps.snapshots.createOnly)
  f.deps.snapshots.createOnly = async (...args) => {
    const result = await upload(...args)
    f.setControl({ ...enabled, paused: true, generation: 2 })
    return result
  }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ error: 'paused' })
  f.setControl(enabled)
  if (kind === 'checksum') f.blobs.set(2, new Uint8Array([1]))
  if (kind === 'missing') f.blobs.delete(2)
  if (kind === 'moved') f.deps.pointer.read = async () => ({ version: 3 })
  if (kind === 'unstopped') f.records.set('batch@2', { ...f.records.get('batch@2')!, commandId: 'unrelated' })
  expect(await publishBatch(f.deps, owner, { ...command, commandId: 'fresh', generation: 3 })).toMatchObject({ ok: false, error: kind === 'moved' ? 'stale_baseline' : kind === 'unstopped' ? 'superseded' : 'version_taken' })
  expect(upload).toHaveBeenCalledTimes(1)
  expect(f.pointer().version).toBe(1)
  expect(f.records.get('batch@2')?.committedAt).toBeUndefined()
})

test('an unrelated command cannot reconcile another command committed release', async () => {
  const f = fixture()
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  expect(await publishBatch(f.deps, owner, { ...command, commandId: 'other' })).toEqual({ ok: false, error: 'superseded' })
})
