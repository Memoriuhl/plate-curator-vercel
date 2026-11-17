import { afterAll, beforeEach, expect, test } from 'vitest'
import { firestorePublishControl, firestorePublishCurator, firestorePublishLock, firestorePublishPointer, firestorePublishRecords } from '../lib/publish/firestore'
import { publishBatch } from '../lib/publish/publish'
import type { PublishLease, PublishRecord } from '../lib/publish/types'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import { batch, command, fixture, owner } from '../tests/publish/fixture'
import { db } from './setup'
import type { Firestore, Transaction } from '@google-cloud/firestore'

const env = 'publish-test'
const now = '2026-11-15T12:00:00Z'
const lease: PublishLease = { ...command, token: 'first', expiresAt: '2026-11-15T12:01:00Z' }
const record: PublishRecord = { id: 'batch@2', ...command, fromVersion: 1, toVersion: 2, blobSha256: 'checksum', url: 'https://storage.example/v2.json?token=t', state: 'uploaded' }
const lock = firestorePublishLock(db, env)
const pointer = firestorePublishPointer(db, env)
const records = firestorePublishRecords(db, env)
const store = firestoreReviewStore(db, env)
const control = firestorePublishControl(db)
const controlActor = { uid: 'owner', email: 'owner@example.com' }
const enabled = { paused: false, generation: 1, changedBy: controlActor, changedAt: now }

beforeEach(async () => {
  await db.doc('config/publishControl').set(enabled)
  await db.doc('members/owner%40example.com').set({ ...controlActor, role: 'owner', status: 'active' })
  await db.recursiveDelete(db.collection('publishCommandStops'))
  await db.doc('locks/publish').delete()
  await db.recursiveDelete(db.collection('publishRecords'))
  await db.doc('reviewBatches/batch').set({ ...batch, env })
  await db.doc('curatorLive/publish-test/batchRevisions/batch').set({ revision: 2 })
  await db.doc('config/catalog').set({ version: 1 })
})

afterAll(async () => {
  await db.doc('config/publishControl').delete()
  await db.doc('members/owner%40example.com').delete()
  await db.recursiveDelete(db.collection('publishCommandStops'))
  await db.doc('locks/publish').delete()
  await db.doc('config/catalog').delete()
  await db.recursiveDelete(db.collection('publishRecords'))
  await db.recursiveDelete(db.collection('reviewBatches'))
  await db.recursiveDelete(db.collection('curatorLive'))
  await db.terminate()
})

test('conditional pointer advance refuses a moved pointer', async () => {
  expect(await lock.claim(lease, now)).toBe(true)
  expect(await records.save(record, lease.token, now)).toBe(true)
  await db.doc('config/catalog').set({ version: 3 })
  expect(await pointer.advance(record, lease, now)).toBe('pointer_moved')
  expect(await pointer.read()).toEqual({ version: 3 })
  expect((await records.get(record.id))?.committedAt).toBeUndefined()
})

test('pointer advancement and its receipt commit together and repeat safely', async () => {
  await lock.claim(lease, now)
  await records.save(record, lease.token, now)
  expect(await pointer.advance(record, lease, now)).toBe('advanced')
  expect(await pointer.read()).toEqual({ version: 2, url: 'https://storage.example/v2.json?token=t', blobSha256: 'checksum', publishedAt: now })
  expect(await records.get(record.id)).toEqual({ ...record, committedAt: now })
  expect(await pointer.advance(record, lease, now)).toBe('advanced')
})

test('records reject stale writers and changes to release identity', async () => {
  await lock.claim(lease, now)
  expect(await records.save(record, lease.token, now)).toBe(true)
  expect(await records.save({ ...record, blobSha256: 'different' }, lease.token, now)).toBe(false)
  expect(await records.save({ ...record, generation: 2 }, lease.token, now)).toBe(false)
  expect(await records.save({ ...record, commandId: 'another-command' }, lease.token, now)).toBe(false)
  expect(await records.save(record, 'other', now)).toBe(false)
  expect(await firestorePublishRecords(db, 'other').get(record.id)).toBeNull()
  expect(await records.get(record.id)).toEqual(record)
})

test('lock claim, renewal, stale takeover and release are fenced', async () => {
  expect(await lock.claim(lease, now)).toBe(true)
  expect(await lock.claim({ ...lease, token: 'other' }, now)).toBe(false)
  expect(await lock.renew({ ...lease, expiresAt: '2026-11-15T12:02:00Z' }, now)).toBe(true)
  const later = '2026-11-15T12:03:00Z'
  const replacement = { ...lease, token: 'replacement', expiresAt: '2026-11-15T12:04:00Z' }
  expect(await lock.claim(replacement, later)).toBe(true)
  expect(await lock.renew(lease, later)).toBe(false)
  expect(await pointer.advance(record, lease, later)).toBe('lock_lost')
  await lock.release(lease.token, false)
  expect((await db.doc('locks/publish').get()).get('token')).toBe('replacement')
  await lock.release(replacement.token, false)
  await lock.release(replacement.token, false)
  expect((await db.doc('locks/publish').get()).exists).toBe(false)
})

test('reservation prevents edits and only its current token can finalize', async () => {
  await lock.claim(lease, now)
  expect(await store.getBatch(batch.id)).toEqual(batch)
  expect(await store.commit(batch.id, 2, { batch: { ...batch, revision: 3, state: 'open' } })).toBe('revision_mismatch')
  expect(await store.commit(batch.id, 2, { batch: { ...batch, revision: 3, state: 'published' }, publishToken: 'wrong' })).toBe('revision_mismatch')
  await lock.release(lease.token, false)
  expect(await store.commit(batch.id, 2, { batch: { ...batch, revision: 3, state: 'open' } })).toBe('ok')
})

test('pointer transaction refuses a superseded batch even with a matching pointer', async () => {
  await lock.claim(lease, now)
  await records.save(record, lease.token, now)
  await db.doc('reviewBatches/batch').update({ revision: 3 })
  expect(await pointer.advance(record, lease, now)).toBe('superseded_revision')
  expect((await pointer.read()).version).toBe(1)
})

test('publishes and reconciles through the Firestore adapters', async () => {
  const f = fixture()
  const deps = { ...f.deps, store, lock, records, pointer, curator: firestorePublishCurator(db, env) }
  const advance = pointer.advance
  deps.pointer = { ...pointer, advance: async (...args) => { await advance(...args); throw new Error('lost response') } }
  expect(await publishBatch(deps, owner, command)).toMatchObject({ ok: false, error: 'unavailable' })
  expect(await store.getBatch(batch.id)).toMatchObject({ state: 'approved', revision: 2 })
  expect((await db.doc('curatorLive/publish-test/batchRevisions/batch').get()).data()).toEqual({ revision: 2 })
  expect((await pointer.read()).version).toBe(2)
  expect(await store.commit(batch.id, 2, { batch: { ...batch, revision: 3, state: 'open' } })).toBe('revision_mismatch')
  deps.pointer = pointer
  const [during, completed] = await Promise.all([
    db.runTransaction(async tx => {
      const draft = await tx.get(db.doc('reviewBatches/batch'))
      const signal = await tx.get(db.doc('curatorLive/publish-test/batchRevisions/batch'))
      return { revision: draft.get('revision'), state: draft.get('state'), signal: signal.data() }
    }, { readOnly: true }),
    publishBatch(deps, owner, command),
  ])
  expect(completed).toMatchObject({ ok: true, value: { state: 'done', toVersion: 2 } })
  expect(during).toEqual(during.revision === 2
    ? { revision: 2, state: 'approved', signal: { revision: 2 } }
    : { revision: 3, state: 'published', signal: { revision: 3 } })
  expect(await store.getBatch(batch.id)).toMatchObject({ state: 'published', revision: 3 })
  expect((await db.doc('curatorLive/publish-test/batchRevisions/batch').get()).data()).toEqual({ revision: 3 })
  expect((await db.doc('locks/publish').get()).exists).toBe(false)
})

test('concurrent lock claims admit exactly one publisher', async () => {
  const results = await Promise.all([lock.claim(lease, now), lock.claim({ ...lease, token: 'other' }, now)])
  expect(results.filter(Boolean)).toHaveLength(1)
})

test('lease expiry compares instants across equivalent timestamp formats', async () => {
  await lock.claim(lease, now)
  const later = '2026-11-15T12:01:00.001Z'
  expect(await lock.claim({ ...lease, token: 'replacement', expiresAt: '2026-11-15T12:02:00Z' }, later)).toBe(true)
})

test('fresh stale Publish releases its lease and reservation without any release writes', async () => {
  const f = fixture()
  const deps = { ...f.deps, store, lock, records, pointer, curator: firestorePublishCurator(db, env) }
  await db.doc('config/catalog').set({ version: 2 })
  expect(await publishBatch(deps, owner, command)).toEqual({ ok: false, error: 'stale_baseline', reviewedVersion: 1, liveVersion: 2 })
  expect([...f.blobs.keys()]).toEqual([1])
  expect(await records.get('batch@2')).toBeNull()
  expect(await store.getBatch(batch.id)).toEqual(batch)
  expect((await db.doc('reviewBatches/batch').get()).get('publishReservation')).toBeUndefined()
  expect((await db.doc('locks/publish').get()).exists).toBe(false)
  expect(await lock.claim({ ...lease, token: 'next' }, now)).toBe(true)
})

test('legacy uncommitted mismatch stops safely and leaves the immutable receipt for triage', async () => {
  const f = fixture()
  const legacy = { ...record, fromVersion: 2, toVersion: 3 }
  await db.doc('publishRecords/batch@2').set({ ...legacy, env })
  const deps = { ...f.deps, store, lock, records, pointer, curator: firestorePublishCurator(db, env) }
  expect(await publishBatch(deps, owner, command)).toMatchObject({ ok: false, error: 'receipt_baseline_conflict' })
  expect(await records.get('batch@2')).toEqual(legacy)
  expect((await pointer.read()).version).toBe(1)
  expect((await db.doc('reviewBatches/batch').get()).get('publishReservation')).toBeUndefined()
})

test('a pointer change after upload is distinguished from an initially stale baseline', async () => {
  const f = fixture()
  const deps = { ...f.deps, store, lock, records, pointer, curator: firestorePublishCurator(db, env) }
  const upload = deps.snapshots.createOnly
  deps.snapshots.createOnly = async (...args) => {
    const result = await upload(...args)
    await db.doc('config/catalog').set({ version: 3 })
    return result
  }
  expect(await publishBatch(deps, owner, command)).toEqual({ ok: false, error: 'pointer_moved' })
  expect([...f.blobs.keys()]).toEqual([1, 2])
  expect((await pointer.read()).version).toBe(3)
  expect(await records.get('batch@2')).toMatchObject({ state: 'failed', failure: 'pointer_moved' })
  expect((await records.get('batch@2'))?.committedAt).toBeUndefined()
  expect(await store.getBatch(batch.id)).toEqual(batch)
  expect((await db.doc('reviewBatches/batch').get()).get('publishReservation')).toBeUndefined()
  expect((await db.doc('locks/publish').get()).exists).toBe(false)
})

test.each([env, 'another-deployment'])('pause committing first stops the pointer at the commit seam for %s', async deployment => {
  const targetStore = firestoreReviewStore(db, deployment)
  await db.doc('reviewBatches/batch').set({ ...batch, env: deployment })
  const f = fixture()
  const targetPointer = firestorePublishPointer(db, deployment)
  const deps = { ...f.deps, control, store: targetStore, lock: firestorePublishLock(db, deployment), records: firestorePublishRecords(db, deployment), pointer: targetPointer, curator: firestorePublishCurator(db, deployment) }
  const advance = targetPointer.advance
  deps.pointer = { ...targetPointer, advance: async (...args) => {
    expect(await control.change(true, controlActor, now)).toMatchObject({ paused: true, generation: 2 })
    return advance(...args)
  } }
  expect(await publishBatch(deps, owner, command)).toEqual({ ok: false, error: 'paused' })
  expect((await targetPointer.read()).version).toBe(1)
  expect(await deps.records.get(record.id)).toMatchObject({ state: 'uploaded', generation: 1 })
  expect((await db.doc('reviewBatches/batch').get()).get('publishReservation')).toBeUndefined()
  expect(await targetStore.getBatch(batch.id)).toEqual(batch)
  await control.change(false, controlActor, now)
  expect(await publishBatch(deps, owner, command)).toEqual({ ok: false, error: 'paused' })
  expect((await targetPointer.read()).version).toBe(1)
})

test('Publish commits first, then Pause, and retries reconcile the same version', async () => {
  const f = fixture()
  let advances = 0
  const deps = { ...f.deps, control, store, lock, records, pointer: { ...pointer, advance: async (...args: Parameters<typeof pointer.advance>) => {
    advances++
    const result = await pointer.advance(...args)
    await control.change(true, controlActor, now)
    expect(await pointer.advance(...args)).toBe('advanced')
    expect(result).toBe('advanced')
    throw new Error('lost commit response')
  } }, curator: firestorePublishCurator(db, env) }
  expect(await publishBatch(deps, owner, command)).toMatchObject({ error: 'unavailable' })
  expect(await publishBatch(deps, owner, command)).toMatchObject({ ok: true, value: { toVersion: 2 } })
  expect(await publishBatch(deps, owner, command)).toMatchObject({ ok: true, value: { toVersion: 2 } })
  expect(advances).toBe(1)
  expect((await pointer.read()).version).toBe(2)
})

test('quick Pause and Resume supersedes the accepted generation at the pointer transaction', async () => {
  await lock.claim(lease, now)
  await records.save(record, lease.token, now)
  await control.change(true, controlActor, now)
  await control.change(false, controlActor, now)
  expect(await pointer.advance(record, lease, now)).toBe('superseded')
  expect((await pointer.read()).version).toBe(1)
  expect((await records.get(record.id))?.committedAt).toBeUndefined()
})

test.each([null, { ...enabled, generation: '1' }, { ...enabled, changedBy: null }])('missing or malformed authoritative control fails closed: %j', async value => {
  await lock.claim(lease, now)
  await records.save(record, lease.token, now)
  if (value) await db.doc('config/publishControl').set(value)
  else await db.doc('config/publishControl').delete()
  expect(await pointer.advance(record, lease, now)).toBe('publish_not_enabled')
  expect((await pointer.read()).version).toBe(1)
})

test('first Resume initializes generation one; every Pause and Resume increments with audit', async () => {
  await db.doc('config/publishControl').delete()
  expect(await control.read()).toBeNull()
  expect(await control.change(false, controlActor, now)).toEqual(enabled)
  expect(await control.change(true, controlActor, now)).toMatchObject({ paused: true, generation: 2, changedBy: controlActor, changedAt: now })
  expect(await control.change(false, controlActor, now)).toMatchObject({ paused: false, generation: 3 })
  expect(await control.change(false, controlActor, now)).toMatchObject({ generation: 4 })
  await db.doc('members/owner%40example.com').update({ role: 'editor' })
  expect(await control.change(true, controlActor, now)).toBeNull()
  expect((await control.read())?.generation).toBe(4)
})

test('a legacy command is superseded even with an enabled control', async () => {
  await lock.claim(lease, now)
  const { generation, commandId, ...legacy } = record
  expect(generation).toBe(1)
  expect(commandId).toBeDefined()
  await records.save(legacy, lease.token, now)
  expect(await pointer.advance(legacy, lease, now)).toBe('superseded')
  expect((await pointer.read()).version).toBe(1)
})

test('unavailable control at the pointer read cannot commit even after successful preflight', async () => {
  const f = fixture()
  const unavailable = {
    doc: db.doc.bind(db),
    runTransaction: (run: (transaction: Transaction) => Promise<unknown>) => db.runTransaction(transaction => run(new Proxy(transaction, {
      get(target, property) {
        if (property === 'getAll') return async () => { throw new Error('control read unavailable') }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }))),
  } as Firestore
  const deps = { ...f.deps, control, store, lock, records, pointer: firestorePublishPointer(unavailable, env), curator: firestorePublishCurator(db, env) }
  expect(await publishBatch(deps, owner, command)).toEqual({ ok: false, error: 'unavailable' })
  expect((await pointer.read()).version).toBe(1)
  expect((await records.get(record.id))?.committedAt).toBeUndefined()
})
