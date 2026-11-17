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

test.each(['checksum', 'moved', 'unstopped'])('receipt adoption refuses %s without uploading again', async kind => {
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

test.each([true, false])('missing prepared blob is recreated only from matching bytes: %s', async matching => {
  const f = fixture()
  const save = f.deps.records.save
  f.deps.records.save = async (...args) => {
    const result = await save(...args)
    if (args[0].state === 'started') f.setControl({ ...enabled, paused: true, generation: 2 })
    return result
  }
  f.deps.snapshots.createOnly = vi.fn(async () => { throw new Error('interrupted before upload') })
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ error: 'paused' })
  expect(await f.deps.control.check(command, f.deps.now())).toBe('paused')
  f.setControl(enabled)
  if (!matching) f.records.set('batch@2', { ...f.records.get('batch@2')!, blobSha256: 'mismatch' })
  f.deps.records.save = save
  const upload = vi.fn(async (version: number, bytes: Uint8Array) => { f.blobs.set(version, bytes); return 'created' as const })
  f.deps.snapshots.createOnly = upload
  const result = await publishBatch(f.deps, owner, { ...command, commandId: 'fresh', generation: 3 })
  expect(result).toMatchObject(matching ? { ok: true, value: { toVersion: 2 } } : { ok: false, error: 'version_taken' })
  expect(upload).toHaveBeenCalledTimes(matching ? 1 : 0)
})

test('an unrelated command cannot reconcile another command committed release', async () => {
  const f = fixture()
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  expect(await publishBatch(f.deps, owner, { ...command, commandId: 'other' })).toEqual({ ok: false, error: 'superseded' })
})

test('D: missing-blob recovery refuses a version already committed by another receipt before any upload', async () => {
  const f = fixture()
  f.deps.snapshots.createOnly = async () => { throw new Error('interrupted upload') }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ error: 'unavailable' })
  f.setControl({ ...enabled, paused: true, generation: 2 })
  expect(await f.deps.control.check(command, f.deps.now())).toBe('paused')
  f.setControl(enabled)
  f.records.set('other@2', { ...f.records.get('batch@2')!, id: 'other@2', batchId: 'other', committedAt: f.deps.now() })
  const upload = vi.fn(async () => 'created' as const)
  f.deps.snapshots.createOnly = upload
  expect(await publishBatch(f.deps, owner, { ...command, generation: 3, commandId: 'fresh' })).toMatchObject({ error: 'version_taken' })
  expect(upload).not.toHaveBeenCalled()
})

test('B1/B2: a replaced claim is superseded at the first check before receipt adoption', async () => {
  const f = fixture()
  f.setControl({ ...enabled, paused: true, generation: 2 })
  expect(await f.deps.control.check(command, f.deps.now())).toBe('paused')
  f.setControl(enabled)
  await f.deps.store.updatePublishMetadata(command.batchId, command.revision, { publishCommand: { commandId: 'new-claim', revision: command.revision } })
  expect(await publishBatch(f.deps, owner, command)).toEqual({ ok: false, error: 'superseded' })
  expect([...f.blobs.keys()]).toEqual([1])
})

test('D: create-only recovery never overwrites different bytes arriving after its proof', async () => {
  const f = fixture()
  f.deps.snapshots.createOnly = async () => { throw new Error('upload interrupted') }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ error: 'unavailable' })
  f.setControl({ ...enabled, paused: true, generation: 2 })
  await f.deps.control.check(command, f.deps.now())
  f.setControl(enabled)
  const proof = f.deps.records.checkUpload
  const different = new Uint8Array([9, 8, 7])
  f.deps.records.checkUpload = async (...args) => {
    const result = await proof(...args)
    if (!result) f.blobs.set(2, different)
    return result
  }
  f.deps.snapshots.createOnly = async (version, bytes) => {
    if (f.blobs.has(version)) return 'exists'
    f.blobs.set(version, bytes)
    return 'created'
  }
  expect(await publishBatch(f.deps, owner, { ...command, generation: 3, commandId: 'fresh' })).toMatchObject({ error: 'version_taken' })
  expect(f.blobs.get(2)).toBe(different)
  expect(f.pointer().version).toBe(1)
})

test.each([false, true])('D: recreating matching bytes refreshes the object URL even after metadata response loss: %s', async responseLost => {
  const f = fixture()
  const upload = f.deps.snapshots.createOnly
  f.deps.snapshots.createOnly = async (...args) => {
    const result = await upload(...args)
    f.setControl({ ...enabled, paused: true, generation: 2 })
    return result
  }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ error: 'paused' })
  f.blobs.delete(2)
  f.deps.snapshots.createOnly = upload
  const downloadUrl = vi.fn(async (): Promise<string | null> => 'https://storage.example/v2.json?token=recreated')
  if (responseLost) downloadUrl.mockResolvedValueOnce(null)
  f.deps.snapshots.downloadUrl = downloadUrl
  f.setControl(enabled)
  const fresh = { ...command, commandId: 'fresh', generation: 3 }
  if (responseLost) expect(await publishBatch(f.deps, owner, fresh)).toMatchObject({ error: 'unavailable' })
  expect(await publishBatch(f.deps, owner, fresh)).toMatchObject({ ok: true, value: { url: 'https://storage.example/v2.json?token=recreated' } })
  expect(f.pointer().url).toBe('https://storage.example/v2.json?token=recreated')
})
