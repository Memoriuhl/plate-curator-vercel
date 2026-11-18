import { afterAll, beforeEach, expect, test } from 'vitest'
import type { Firestore, Transaction } from '@google-cloud/firestore'
import { abandonPreparedSnapshot } from '../lib/publish/abandon'
import { publishBatch } from '../lib/publish/publish'
import { firestorePublishRecords } from '../lib/publish/firestore'
import { batch, command, owner } from '../tests/publish/fixture'
import { actor, cleanupRelease, env, now, releaseFixture, resetRelease } from './release-fixture'
import { db } from './setup'

beforeEach(resetRelease)
afterAll(cleanupRelease)

/**
 * Create an interrupted publish receipt and pause its command so tests can exercise
 * abandonment.
 */
async function prepared(uploaded = false) {
  const f = releaseFixture()
  const upload = f.deps.snapshots.createOnly
  f.deps.snapshots.createOnly = async (...args) => { if (uploaded) await upload(...args); throw new Error('interrupted') }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ error: 'unavailable' })
  await f.deps.control.change(true, actor, now)
  await f.deps.control.check(command, now)
  f.deps.snapshots.createOnly = upload
  return { ...f, record: (await f.deps.records.get('batch@2'))! }
}

test.each([false, true])('burn, archive, all bound stops and disposition commit atomically (object: %s)', async uploaded => {
  const f = await prepared(uploaded)
  const result = await abandonPreparedSnapshot(f.deps, actor, f.record, 'Choose another Batch')
  expect(result).toMatchObject({ ok: true, value: { burnedVersion: 2, object: uploaded ? await f.deps.snapshots.metadata(2) : null } })
  expect(await abandonPreparedSnapshot(f.deps, actor, f.record, 'duplicate')).toEqual(result)
  expect(await f.deps.records.get('batch@2')).toBeNull()
  expect(await f.deps.records.get('batch@2--command')).toMatchObject({ state: 'abandoned' })
  expect((await db.doc('publishVersionBurns/2').get()).get('receiptId')).toBe('batch@2--command')
  expect(await f.deps.records.stopped(command)).toBe('paused')
  expect(await f.deps.store.getBatch(batch.id)).toMatchObject({ publishAbandonment: { burnedVersion: 2 }, state: 'approved' })
  expect((await f.deps.pointer.read()).version).toBe(1)
  expect(f.blobs.has(2)).toBe(uploaded)
  expect(await f.deps.store.commit(batch.id, 2, { batch: { ...batch, state: 'open', revision: 3 } })).toBe('ok')
  expect((await f.deps.store.getBatch(batch.id))?.publishAbandonment?.burnedVersion).toBe(2)
})

test('failure after staging the archive rolls back the burn, stops, receipt and Batch audit', async () => {
  const f = await prepared()
  const failing = new Proxy(db, { /** Wrap Firestore transactions so the fixture can inject a failure during abandonment. */ get(target, key) {
    if (key === 'runTransaction') return (run: (tx: Transaction) => Promise<unknown>) => db.runTransaction(tx => run(new Proxy(tx, { /** Fail the version burn write and pass other transaction operations through to Firestore. */ get(transaction, method) {
      if (method === 'create') return (ref: Parameters<Transaction['create']>[0], data: Record<string, unknown>) => {
        if (ref.path.startsWith('publishVersionBurns/')) throw new Error('injected rollback')
        return transaction.create(ref, data)
      }
      const value = Reflect.get(transaction, method)
      return typeof value === 'function' ? value.bind(transaction) : value
    } })))
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } }) as Firestore
  f.deps.records = firestorePublishRecords(failing, env)
  expect(await abandonPreparedSnapshot(f.deps, actor, f.record, 'rollback')).toMatchObject({ error: 'unavailable' })
  expect(await f.deps.records.get('batch@2')).toEqual(f.record)
  expect(await f.deps.records.get('batch@2--command')).toBeNull()
  expect((await db.doc('publishVersionBurns/2').get()).exists).toBe(false)
  expect((await f.deps.store.getBatch(batch.id))?.publishAbandonment).toBeUndefined()
})

test('allocator excludes burns and legacy held/committed receipts in other environments without reservation documents', async () => {
  const f = releaseFixture()
  await db.doc('publishVersionBurns/2').set({ receiptId: 'old', object: null })
  const record = { id: 'held', ...command, fromVersion: 1, toVersion: 3, state: 'started', blobSha256: 'held', env: 'another-environment' }
  await db.doc('publishRecords/held').set(record)
  await db.doc('publishCommandStops/command').set({ reason: 'paused' })
  await db.doc('publishRecords/committed').set({ ...record, id: 'committed', toVersion: 4, state: 'done', committedAt: now })
  const lease = { ...command, token: 'allocation', expiresAt: '2026-11-15T12:01:00Z' }
  expect(await f.deps.lock.claim(lease, now)).toBe(true)
  expect(await f.deps.records.nextVersion(lease.token, now)).toBe(5)
  await f.deps.lock.release(lease.token, false)
})

test('same-command reservation is idempotent; legacy no-burn allocation remains +1', async () => {
  const f = releaseFixture()
  const upload = f.deps.snapshots.createOnly
  f.deps.snapshots.createOnly = async () => { throw new Error('before upload') }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ error: 'unavailable' })
  expect(await f.deps.records.get('batch@2')).toMatchObject({ toVersion: 2 })
  f.deps.snapshots.createOnly = upload
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true, value: { toVersion: 2 } })
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true, value: { toVersion: 2 } })
  expect((await db.collection('publishRecords').get()).size).toBe(1)
})

test.each(['abandon first', 'retry first', 'retry then stop'])('abandon versus fresh retry serializes under lease: %s', async order => {
  const f = await prepared(true)
  await f.deps.control.change(false, actor, now)
  const fresh = { ...command, commandId: 'fresh', generation: 3 }
  if (order !== 'abandon first') {
    expect(await f.deps.records.accept(fresh, now)).toMatchObject({ ok: true })
    expect(await f.deps.records.bindRun(fresh, 'live-run', now)).toBe(true)
    const lease = { ...fresh, token: 'adopt', expiresAt: '2026-11-15T12:01:00Z' }
    expect(await f.deps.lock.claim(lease, now)).toBe(true)
    expect(await f.deps.records.adopt(f.record, fresh, f.record.blobSha256, lease.token, now)).toMatchObject({ commandId: 'fresh' })
    await f.deps.lock.release(lease.token, false)
    f.record = (await f.deps.records.get('batch@2'))!
  }
  if (order === 'retry then stop') {
    await f.deps.control.change(true, actor, now)
    await f.deps.control.check(fresh, now)
  }
  expect(await abandonPreparedSnapshot(f.deps, actor, f.record, 'Choose another')).toMatchObject(order === 'retry first' ? { error: 'locked' } : { ok: true })
  if (order === 'abandon first') {
    expect(await f.deps.records.accept(fresh, now)).toMatchObject({ ok: true })
    expect(await publishBatch(f.deps, owner, fresh)).toMatchObject({ ok: true, value: { toVersion: 3 } })
  }
  if (order === 'retry then stop') expect(await f.deps.records.stopped(fresh)).toBe('paused')
})

test('delayed create-only after the burn cannot save or advance its old receipt', async () => {
  const f = await prepared()
  expect(await abandonPreparedSnapshot(f.deps, actor, f.record, 'burn delayed upload')).toMatchObject({ ok: true })
  expect(await f.deps.snapshots.createOnly(2, Buffer.from('late old bytes'))).toBe('created')
  await f.deps.control.change(false, actor, now)
  const lease = { ...command, token: 'late', expiresAt: '2026-11-15T12:01:00Z' }
  expect(await f.deps.lock.claim(lease, now)).toBe(true)
  expect(await f.deps.records.save(f.record, lease.token, now)).toBe(false)
  expect(await f.deps.pointer.advance(f.record, lease, now)).toBe('version_taken')
  await f.deps.lock.release(lease.token, false)
  await db.doc('reviewBatches/other').set({ ...batch, id: 'other', env })
  expect(await publishBatch(f.deps, owner, { ...command, commandId: 'other', batchId: 'other', generation: 3 })).toMatchObject({ ok: true, value: { toVersion: 3 } })
  expect((await f.deps.pointer.read()).version).toBe(3)
})

test('abandonment protects committed receipts and checks current actor epoch in the transaction', async () => {
  const f = await prepared(true)
  expect(await abandonPreparedSnapshot(f.deps, { ...actor, authorityEpoch: 99 }, f.record, 'stale authority')).toMatchObject({ error: 'forbidden' })
  await db.doc('publishRecords/batch@2').update({ committedAt: now })
  expect(await abandonPreparedSnapshot(f.deps, actor, f.record, 'committed')).toMatchObject({ error: 'version_taken' })
  expect((await db.collection('publishVersionBurns').get()).empty).toBe(true)
})

test.each(['not_found', 'transient', 'running'])('abandon takeover uses confirmed Workflow state: %s', async status => {
  const f = releaseFixture({ /** Provide controlled workflow status for the publish or queue recovery scenario. */ runStatus: async () => { if (status === 'transient') throw new Error('temporary'); return status }, /** Control discovery by command token when the fixture has no recorded workflow ID. */ findRun: async () => null })
  await f.deps.records.accept(command, now)
  await f.deps.records.bindRun(command, 'old-run', now)
  const upload = f.deps.snapshots.createOnly
  f.deps.snapshots.createOnly = async () => { throw new Error('crash') }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ error: 'unavailable' })
  f.deps.snapshots.createOnly = upload
  f.deps.now = () => '2026-11-15T12:03:00Z'
  const record = (await f.deps.records.get('batch@2'))!
  expect(await abandonPreparedSnapshot(f.deps, actor, record, 'terminal recovery')).toMatchObject(status === 'not_found' ? { ok: true } : { error: 'locked' })
})

test('non-adjacent reservation survives upload stop and fresh-command adoption', async () => {
  const f = releaseFixture()
  await db.doc('publishVersionBurns/2').set({ receiptId: 'older' })
  const upload = f.deps.snapshots.createOnly
  f.deps.snapshots.createOnly = async (...args) => { const result = await upload(...args); await f.deps.control.change(true, actor, now); return result }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ error: 'paused' })
  await f.deps.control.change(false, actor, now)
  const fresh = { ...command, commandId: 'gap-adopter', generation: 3 }
  expect(await f.deps.records.accept(fresh, now)).toMatchObject({ ok: true })
  expect(await publishBatch(f.deps, owner, fresh)).toMatchObject({ ok: true, value: { toVersion: 3 } })
  expect((await f.deps.snapshots.read(3)).version).toBe(3)
})

test('adoption cannot commit a target already committed by a receipt in another environment', async () => {
  const f = await prepared(true)
  await db.doc('publishRecords/foreign-commit').set({ ...f.record, id: 'foreign-commit', batchId: 'foreign', env: 'foreign', committedAt: now })
  await f.deps.control.change(false, actor, now)
  expect(await publishBatch(f.deps, owner, { ...command, commandId: 'fresh', generation: 3 })).toMatchObject({ error: 'version_taken' })
  expect((await f.deps.pointer.read()).version).toBe(1)
})

test('a suspended old upload lands only in its burned slot after lease takeover', async () => {
  const f = releaseFixture()
  let entered!: () => void
  const uploading = new Promise<void>(resolve => { entered = resolve })
  let resume!: () => void
  const delayed = new Promise<void>(resolve => { resume = resolve })
  const upload = f.deps.snapshots.createOnly
  f.deps.snapshots.createOnly = async (...args) => { entered(); await delayed; return upload(...args) }
  const old = publishBatch(f.deps, owner, command)
  await uploading
  f.deps.now = () => '2026-11-15T12:03:00Z'
  await f.deps.control.change(true, actor, f.deps.now())
  await f.deps.control.check(command, f.deps.now())
  const record = (await f.deps.records.get('batch@2'))!
  expect(await abandonPreparedSnapshot(f.deps, actor, record, 'burn in-flight create')).toMatchObject({ ok: true })
  resume()
  expect(await old).toMatchObject({ ok: false, error: 'lock_lost' })
  expect(f.blobs.has(2)).toBe(true)
  expect((await f.deps.pointer.read()).version).toBe(1)
  f.deps.snapshots.createOnly = upload
  await f.deps.control.change(false, actor, f.deps.now())
  await db.doc('reviewBatches/other').set({ ...batch, id: 'other', env })
  expect(await publishBatch(f.deps, owner, { ...command, batchId: 'other', commandId: 'other', generation: 3 })).toMatchObject({ ok: true, value: { toVersion: 3 } })
}, 15000)

test('a fenced Batch can abandon its stopped older receipt without freezing its newer revision', async () => {
  const f = await prepared()
  await db.doc('reviewBatches/batch').update({ state: 'open', revision: 3, approval: null })
  expect(await abandonPreparedSnapshot(f.deps, actor, f.record, 'fenced attempt')).toMatchObject({ ok: true })
  expect(await f.deps.store.getBatch(batch.id)).toMatchObject({ state: 'open', revision: 3, publishAbandonment: { burnedVersion: 2 } })
  expect((await db.doc('reviewBatches/batch').get()).get('publishReservation')).toBeUndefined()
})
