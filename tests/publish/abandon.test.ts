import { expect, test } from 'vitest'
import { abandonPreparedSnapshot } from '../../lib/publish/abandon'
import { publishBatch } from '../../lib/publish/publish'
import { nextPublishVersion } from '../../lib/publish/allocation'
import { validateSnapshot } from '../../lib/publish/validation'
import { batch, command, fixture, owner } from './fixture'

const authority = command.requestedBy

test('stopped A is abandoned, B publishes different bytes at v3, and old A cannot commit', async () => {
  const f = fixture()
  const upload = f.deps.snapshots.createOnly
  f.deps.snapshots.createOnly = async (...args) => {
    const result = await upload(...args)
    f.setControl({ paused: true, generation: 2, changedBy: authority, changedAt: f.deps.now() })
    return result
  }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ error: 'paused' })
  const receipt = f.records.get('batch@2')!
  const bytes = f.blobs.get(2)
  expect(await abandonPreparedSnapshot(f.deps, authority, receipt, 'Publish B instead')).toMatchObject({ ok: true, value: { burnedVersion: 2 } })
  f.setControl({ paused: false, generation: 3, changedBy: authority, changedAt: f.deps.now() })
  f.deps.snapshots.createOnly = upload
  await f.deps.store.create({ ...batch, id: 'other', name: 'B' })
  f.deps.store.listEdits = async () => [{ plateId: 'one', baseRevision: 'base', fields: { tags: ['B'] }, authorId: owner.uid, updatedAt: f.deps.now(), resultRevision: 'B' }]
  expect(await publishBatch(f.deps, owner, { ...command, batchId: 'other', commandId: 'other-command', generation: 3 })).toMatchObject({ ok: true, value: { toVersion: 3 } })
  expect(f.pointer().version).toBe(3)
  expect((await f.deps.snapshots.read(3)).version).toBe(3)
  expect((await f.deps.snapshots.read(3)).plates[0].tags).toEqual(['B'])
  expect(f.blobs.get(2)).toBe(bytes)
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ error: 'paused' })
})

async function stoppedBeforeUpload() {
  const f = fixture()
  const save = f.deps.records.save
  f.deps.records.save = async (...args) => {
    const result = await save(...args)
    if (args[0].state === 'started') f.setControl({ paused: true, generation: 2, changedBy: authority, changedAt: f.deps.now() })
    return result
  }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ error: 'paused' })
  f.deps.records.save = save
  await f.deps.control.check(command, f.deps.now())
  return f
}

test('no-object abandonment is idempotent and a fresh same-revision attempt recomputes bytes', async () => {
  const f = await stoppedBeforeUpload()
  const receipt = f.records.get('batch@2')!
  const first = await abandonPreparedSnapshot(f.deps, authority, receipt, 'No longer needed')
  expect(first).toMatchObject({ ok: true, value: { object: null, burnedVersion: 2 } })
  expect(await abandonPreparedSnapshot(f.deps, authority, receipt, 'duplicate')).toEqual(first)
  expect(f.records.get('batch@2')).toBeUndefined()
  expect(f.records.get('batch@2--command')).toMatchObject({ state: 'abandoned' })
  expect(await f.deps.store.getBatch(batch.id)).toMatchObject({ publishAbandonment: { burnedVersion: 2 } })
  f.setControl({ paused: false, generation: 3, changedBy: authority, changedAt: f.deps.now() })
  const fresh = { ...command, commandId: 'fresh', generation: 3 }
  expect(await f.deps.records.accept(fresh, f.deps.now())).toMatchObject({ ok: true })
  f.deps.snapshots.createOnly = async (version, bytes) => { f.blobs.set(version, bytes); return 'created' }
  expect(await publishBatch(f.deps, owner, fresh)).toMatchObject({ ok: true, value: { toVersion: 3 } })
  expect(f.records.get('batch@2--command')?.state).toBe('abandoned')
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: false })
})

test('fresh click first locks abandonment until its adopted run stops', async () => {
  const f = await stoppedBeforeUpload()
  const receipt = f.records.get('batch@2')!
  f.setControl({ paused: false, generation: 3, changedBy: authority, changedAt: f.deps.now() })
  const fresh = { ...command, commandId: 'fresh', generation: 3 }
  expect(await f.deps.records.accept(fresh, f.deps.now())).toMatchObject({ ok: true })
  expect(await f.deps.records.bindRun(fresh, 'live-run', f.deps.now())).toBe(true)
  expect(await abandonPreparedSnapshot(f.deps, authority, receipt, 'competing abandon')).toMatchObject({ error: 'locked' })
  f.setControl({ paused: true, generation: 4, changedBy: authority, changedAt: f.deps.now() })
  await f.deps.control.check(fresh, f.deps.now())
  expect(await abandonPreparedSnapshot(f.deps, authority, receipt, 'run stopped')).toMatchObject({ ok: true })
  expect(await f.deps.records.stopped(fresh)).toBe('paused')
})

test('delayed old createOnly can land after abandonment but can never become referenced', async () => {
  const f = await stoppedBeforeUpload()
  const receipt = f.records.get('batch@2')!
  let lateBytes: Uint8Array | undefined
  f.deps.snapshots.createOnly = async (_version, bytes) => { lateBytes = bytes; throw new Error('delayed create') }
  f.setControl({ paused: false, generation: 3, changedBy: authority, changedAt: f.deps.now() })
  expect(await publishBatch(f.deps, owner, { ...command, commandId: 'adopter', generation: 3 })).toMatchObject({ error: 'unavailable' })
  const adopted = f.records.get('batch@2')!
  f.setControl({ paused: true, generation: 4, changedBy: authority, changedAt: f.deps.now() })
  await f.deps.control.check(adopted, f.deps.now())
  expect(await abandonPreparedSnapshot(f.deps, authority, adopted, 'Choose B')).toMatchObject({ ok: true })
  f.blobs.set(2, lateBytes!)
  f.setControl({ paused: false, generation: 5, changedBy: authority, changedAt: f.deps.now() })
  f.deps.snapshots.createOnly = async (version, bytes) => { if (f.blobs.has(version)) return 'exists'; f.blobs.set(version, bytes); return 'created' }
  await f.deps.store.create({ ...batch, id: 'B' })
  expect(await publishBatch(f.deps, owner, { ...command, batchId: 'B', commandId: 'B', generation: 5 })).toMatchObject({ ok: true, value: { toVersion: 3 } })
  expect(await publishBatch(f.deps, owner, adopted)).toMatchObject({ ok: false })
  expect(f.pointer().version).toBe(3)
  expect(f.blobs.has(receipt.toVersion)).toBe(true)
})

test('committed receipt and its generation remain protected', async () => {
  const f = fixture()
  const advance = f.deps.pointer.advance
  f.deps.pointer.advance = async (...args) => { await advance(...args); throw new Error('lost response') }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ error: 'unavailable' })
  const receipt = f.records.get('batch@2')!
  const object = await f.deps.snapshots.metadata(2)
  expect(await abandonPreparedSnapshot(f.deps, authority, receipt, 'too late')).toMatchObject({ error: 'version_taken' })
  expect(await f.deps.snapshots.metadata(2)).toEqual(object)
  expect(f.burns.size).toBe(0)
})

test('allocator skips multiple burns, held and all committed targets and rejects exhaustion', () => {
  const held = { id: 'held', ...command, fromVersion: 1, toVersion: 4, blobSha256: 'held', state: 'started' as const }
  expect(nextPublishVersion(1, [2, 3], [held, { ...held, toVersion: 5, state: 'done', committedAt: 'committed' }])).toBe(6)
  expect(() => nextPublishVersion(Number.MAX_SAFE_INTEGER, [], [])).toThrow('exhausted')
})

test('non-adjacent reserved receipt is adopted without changing its version', async () => {
  const f = fixture()
  f.burns.set(2, { receiptId: 'prior', commandId: 'prior', burnedVersion: 2, by: authority, at: f.deps.now(), reason: 'prior', object: null })
  const upload = f.deps.snapshots.createOnly
  f.deps.snapshots.createOnly = async (...args) => { const result = await upload(...args); f.setControl({ paused: true, generation: 2, changedBy: authority, changedAt: f.deps.now() }); return result }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ error: 'paused' })
  expect(f.records.get('batch@2')?.toVersion).toBe(3)
  f.setControl({ paused: false, generation: 3, changedBy: authority, changedAt: f.deps.now() })
  expect(await publishBatch(f.deps, owner, { ...command, commandId: 'fresh', generation: 3 })).toMatchObject({ ok: true, value: { toVersion: 3 } })
  expect(validateSnapshot(await f.deps.snapshots.read(1), await f.deps.snapshots.read(3))).toEqual([])
})

test('mismatched object identity is recorded for audit without a checksum requirement', async () => {
  const f = await stoppedBeforeUpload()
  const receipt = f.records.get('batch@2')!
  f.blobs.set(2, Buffer.from('different bytes'))
  const object = await f.deps.snapshots.metadata(2)
  f.deps.snapshots.checksum = async () => { throw new Error('checksum must not be required') }
  expect(await abandonPreparedSnapshot(f.deps, authority, receipt, 'Discard mismatched attempt')).toMatchObject({ ok: true, value: { object } })
  expect(await f.deps.snapshots.metadata(2)).toEqual(object)
})

test('old work cannot resurrect its receipt after the burn even under a new lease', async () => {
  const f = await stoppedBeforeUpload()
  const receipt = f.records.get('batch@2')!
  expect(await abandonPreparedSnapshot(f.deps, authority, receipt, 'burn')).toMatchObject({ ok: true })
  const lease = { ...command, token: 'late', expiresAt: '2026-11-15T12:01:00Z' }
  expect(await f.deps.lock.claim(lease, f.deps.now())).toBe(true)
  expect(await f.deps.records.save(receipt, lease.token, f.deps.now())).toBe(false)
  expect(f.records.has('batch@2')).toBe(false)
})

test('a stopped receipt remains abandonable after its Batch was fenced out of approved', async () => {
  const f = await stoppedBeforeUpload()
  const receipt = f.records.get('batch@2')!
  expect(await f.deps.store.commit(batch.id, 2, { batch: { ...batch, state: 'open', revision: 3, approval: null } })).toBe('ok')
  expect(await abandonPreparedSnapshot(f.deps, authority, receipt, 'fenced legacy attempt')).toMatchObject({ ok: true })
  expect(await f.deps.store.getBatch(batch.id)).toMatchObject({ state: 'open', revision: 3, publishAbandonment: { burnedVersion: 2 } })
})

test('another Batch skips a held slot without abandoning it; later disposition succeeds below the live pointer', async () => {
  const f = await stoppedBeforeUpload()
  const receipt = f.records.get('batch@2')!
  f.setControl({ paused: false, generation: 3, changedBy: authority, changedAt: f.deps.now() })
  await f.deps.store.create({ ...batch, id: 'other' })
  expect(await publishBatch(f.deps, owner, { ...command, batchId: 'other', commandId: 'other', generation: 3 })).toMatchObject({ ok: true, value: { toVersion: 3 } })
  expect(f.records.get(receipt.id)?.state).toBe('started')
  expect(await f.deps.records.abandonmentEligibility(receipt, f.deps.now())).toBeNull()
  expect(await abandonPreparedSnapshot(f.deps, authority, receipt, 'Disposition after B shipped')).toMatchObject({ ok: true, value: { burnedVersion: 2 } })
  expect(f.pointer().version).toBe(3)
})

test('disposition refuses a target committed by any other receipt', async () => {
  const f = await stoppedBeforeUpload()
  const receipt = f.records.get('batch@2')!
  f.records.set('foreign', { ...receipt, id: 'foreign', batchId: 'foreign', committedAt: f.deps.now() })
  expect(await abandonPreparedSnapshot(f.deps, authority, receipt, 'Must protect committed target')).toMatchObject({ error: 'version_taken' })
  expect(f.burns.size).toBe(0)
})

test('a healthy live attempt stays locked even if another receipt conflicts with its target', async () => {
  const f = fixture()
  await f.deps.records.accept(command, f.deps.now())
  await f.deps.records.bindRun(command, 'live-run', f.deps.now())
  f.deps.snapshots.createOnly = async () => { throw new Error('upload pending') }
  await publishBatch(f.deps, owner, command)
  const receipt = f.records.get('batch@2')!
  f.records.set('foreign', { ...receipt, id: 'foreign', batchId: 'foreign', committedAt: f.deps.now() })
  expect(await f.deps.records.abandonmentEligibility(receipt, f.deps.now())).toBe('locked')
})
