import { firestoreMembersStore } from '../lib/members/firestore-store'
import { afterAll, beforeEach, expect, test } from 'vitest'
import { firestorePublishControl, firestorePublishCurator, firestorePublishLock, firestorePublishPointer, firestorePublishRecords } from '../lib/publish/firestore'
import { publishBatch } from '../lib/publish/publish'
import { sha256 } from '../lib/publish/bytes'
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
const records = firestorePublishRecords(db, env, { findRun: async () => null })
const store = firestoreReviewStore(db, env)
const control = firestorePublishControl(db)
const controlActor = { uid: 'owner', email: 'owner@example.com' }
const enabled = { paused: false, generation: 1, changedBy: controlActor, changedAt: now }

test.each(['unbound', 'completed', 'failed', 'cancelled'])('claimRecovery replaces a %s claim and fences its previous command', async status => {
  const recovering = firestorePublishRecords(db, env, { runStatus: async () => status, findRun: async () => null })
  const first = { ...command, commandId: 'abandoned' }
  await recovering.accept(first, now)
  if (status !== 'unbound') await recovering.bindRun(first, 'old-run', now)
  const next = { ...command, commandId: 'next-click' }
  const later = '2026-11-15T12:02:01Z'
  expect(await recovering.accept(next, later)).toMatchObject({ ok: true, command: next })
  expect((await db.doc('publishCommandStops/abandoned').get()).get('reason')).toBe('superseded')
})

test('B3: two Owners racing takeover of one stale claim produce exactly one winner', async () => {
  await records.accept({ ...command, commandId: 'stale-claim' }, now)
  const later = '2026-11-15T12:02:01Z'
  const a = { ...command, commandId: 'takeover-a' }
  const b = { ...command, commandId: 'takeover-b', requestedBy: { uid: 'backup', email: 'backup@example.com', authorityEpoch: 0 } }
  const results = await Promise.all([records.accept(a, later), records.accept(b, later)])
  expect(results.filter(result => result.ok)).toHaveLength(1)
  expect(results.filter(result => !result.ok)).toEqual([{ ok: false, error: 'locked' }])
  expect((await db.doc('publishCommandStops/stale-claim').get()).get('reason')).toBe('superseded')
}, 15000)

test('B5: failure between staging supersede and replacing the claim rolls both back', async () => {
  await records.accept({ ...command, commandId: 'old-claim' }, now)
  let stagedStop = false
  const failing = new Proxy(db, { get(target, key) {
    if (key === 'runTransaction') return (run: (tx: Transaction) => Promise<unknown>) => db.runTransaction(tx => run(new Proxy(tx, { get(transaction, method) {
      if (method === 'create') return (ref: { path: string }, data: Record<string, unknown>) => {
        if (ref.path === 'publishCommandStops/old-claim') stagedStop = true
        if (ref.path === 'publishCommands/replacement') throw new Error('injected between stop and claim')
        return transaction.create(ref as Parameters<Transaction['create']>[0], data)
      }
      const value = Reflect.get(transaction, method)
      return typeof value === 'function' ? value.bind(transaction) : value
    } })))
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } }) as Firestore
  await expect(firestorePublishRecords(failing, env, { findRun: async () => null }).accept({ ...command, commandId: 'replacement' }, '2026-11-15T12:02:01Z')).rejects.toThrow('injected between stop and claim')
  expect(stagedStop).toBe(true)
  expect((await db.doc('publishCommandStops/old-claim').get()).exists).toBe(false)
  expect(await records.command('replacement')).toBeNull()
  expect(await store.getBatch(batch.id)).toMatchObject({ publishCommand: { commandId: 'old-claim' } })
})

test.each(['terminal', 'stopped'])('B2: old work after %s takeover cannot check, adopt or commit', async reason => {
  const target = firestorePublishRecords(db, env, { runStatus: async () => reason === 'terminal' ? 'failed' : 'running' })
  await target.accept(command, now)
  await target.bindRun(command, 'old-run', now)
  const f = fixture()
  const bytes = Buffer.from('prepared immutable bytes')
  f.blobs.set(2, bytes)
  const prepared = { ...record, blobSha256: sha256(bytes) }
  await lock.claim(lease, now)
  await target.save(prepared, lease.token, now)
  await lock.release(lease.token, false)
  if (reason === 'stopped') await db.doc(`publishCommandStops/${command.commandId}`).set({ reason: 'paused' })
  const fresh = { ...command, commandId: 'new-owner-command' }
  expect(await target.accept(fresh, now)).toMatchObject({ ok: true })
  expect(await target.bindRun(fresh, 'new-run', now)).toBe(true)
  const deps = { ...f.deps, control, store, lock, records: target, pointer, curator: firestorePublishCurator(db, env) }
  expect(await publishBatch(deps, owner, command)).toMatchObject({ error: 'superseded' })
  const nextLease = { ...lease, token: 'fresh-lease' }
  expect(await lock.claim(nextLease, now)).toBe(true)
  expect(await target.adopt(prepared, command, prepared.blobSha256, nextLease.token, now)).toBe('superseded')
  expect(await pointer.advance(prepared, nextLease, now)).toBe('superseded')
  await lock.release(nextLease.token, false)
  expect((await pointer.read()).version).toBe(1)
  expect(await publishBatch(deps, owner, fresh)).toMatchObject({ ok: true, value: { toVersion: 2 } })
})

test.each(['owner', 'batch', 'revision', 'version', 'committed', 'other-commit', 'checksum', 'pointer', 'stopped'])('D: transactional before-upload proof refuses %s', async changed => {
  await lock.claim(lease, now)
  await records.save(record, lease.token, now)
  const ref = db.doc(`publishRecords/${record.id}`)
  if (changed === 'owner') await ref.update({ commandId: 'another-command' })
  if (changed === 'batch') await ref.update({ batchId: 'another-batch' })
  if (changed === 'revision') await ref.update({ revision: 3 })
  if (changed === 'version') await ref.update({ toVersion: 3 })
  if (changed === 'committed') await ref.update({ committedAt: now })
  if (changed === 'other-commit') await db.doc('publishRecords/other@2').set({ ...record, id: 'other@2', batchId: 'other', env, committedAt: now })
  if (changed === 'pointer') await db.doc('config/catalog').update({ version: 3 })
  if (changed === 'stopped') await db.doc(`publishCommandStops/${command.commandId}`).set({ reason: 'superseded' })
  expect(await records.checkUpload(record, command, changed === 'checksum' ? 'different' : record.blobSha256, lease.token, now)).toBe(changed === 'owner' || changed === 'stopped' ? 'superseded' : changed === 'pointer' ? 'stale_baseline' : 'version_taken')
})

test('D: a create-only re-upload cannot overwrite different bytes arriving after its transactional proof', async () => {
  const f = fixture()
  const deps = { ...f.deps, control, store, lock, records, pointer, curator: firestorePublishCurator(db, env) }
  const createOnly = deps.snapshots.createOnly
  deps.snapshots.createOnly = async () => { throw new Error('interrupted before storage') }
  expect(await publishBatch(deps, owner, command)).toMatchObject({ error: 'unavailable' })
  await control.change(true, controlActor, now)
  await control.check(command, now)
  await control.change(false, controlActor, now)
  const different = new Uint8Array([9, 8, 7])
  deps.records = { ...records, checkUpload: async (...args) => {
    const result = await records.checkUpload(...args)
    if (!result) f.blobs.set(2, different)
    return result
  } }
  deps.snapshots.createOnly = createOnly
  expect(await publishBatch(deps, owner, { ...command, generation: 3, commandId: 'reupload' })).toMatchObject({ error: 'version_taken' })
  expect(f.blobs.get(2)).toBe(different)
  expect((await pointer.read()).version).toBe(1)
})

test('two Owners racing through accept admit exactly one command and commit one Catalog version', async () => {
  const f = fixture()
  const deps = { ...f.deps, control, store, lock, records, pointer, curator: firestorePublishCurator(db, env) }
  const upload = deps.snapshots.createOnly
  deps.snapshots.createOnly = async (...args) => {
    const result = await upload(...args)
    await control.change(true, controlActor, now)
    return result
  }
  expect(await publishBatch(deps, owner, command)).toMatchObject({ error: 'paused' })
  await control.change(false, controlActor, now)
  const a = { ...command, generation: 3, commandId: 'owner-a-click' }
  const b = { ...a, commandId: 'owner-b-click', requestedBy: { uid: 'backup', email: 'backup@example.com', authorityEpoch: 0 } }
  const outcomes = await Promise.all([records.accept(a, now), records.accept(b, now)])
  expect(outcomes.filter(result => result.ok)).toHaveLength(1)
  expect(outcomes.filter(result => !result.ok)).toEqual([{ ok: false, error: 'locked' }])
  const winner = outcomes.find(result => result.ok)!
  if (!winner.ok) throw new Error('no winner')
  await records.bindRun(winner.command, 'winner-run', now)
  expect(await publishBatch(deps, { ...owner, uid: winner.command.requestedBy!.uid }, winner.command)).toMatchObject({ ok: true, value: { toVersion: 2 } })
  expect(await publishBatch(deps, { ...owner, uid: winner.command.requestedBy!.uid }, winner.command)).toMatchObject({ ok: true, value: { toVersion: 2 } })
  expect((await pointer.read()).version).toBe(2)
  expect([...f.blobs.keys()]).toEqual([1, 2])
}, 15000)

test.each([true, false])('missing blob adoption recomputes and uploads only identical bytes in Firestore: %s', async matching => {
  const f = fixture()
  const deps = { ...f.deps, control, store, lock, records, pointer, curator: firestorePublishCurator(db, env) }
  const upload = deps.snapshots.createOnly
  let writes = 0
  deps.snapshots.createOnly = async () => { throw new Error('lost process before upload') }
  expect(await publishBatch(deps, owner, command)).toMatchObject({ error: 'unavailable' })
  await control.change(true, controlActor, now)
  expect(await control.check(command, now)).toBe('paused')
  await control.change(false, controlActor, now)
  if (!matching) await db.doc(`publishRecords/${record.id}`).update({ blobSha256: 'different' })
  deps.snapshots.createOnly = async (...args) => { writes++; return upload(...args) }
  const fresh = { ...command, generation: 3, commandId: 'missing-blob-click' }
  expect(await publishBatch(deps, owner, fresh)).toMatchObject(matching ? { ok: true, value: { toVersion: 2 } } : { ok: false, error: 'version_taken' })
  expect(writes).toBe(matching ? 1 : 0)
  expect((await pointer.read()).version).toBe(matching ? 2 : 1)
})

beforeEach(async () => {
  await db.recursiveDelete(db.collection('publishCommands'))
  await db.doc('config/publishControl').set(enabled)
  await db.doc('members/owner%40example.com').set({ ...controlActor, role: 'owner', status: 'active' })
  await db.doc('members/backup%40example.com').set({ uid: 'backup', email: 'backup@example.com', role: 'owner', status: 'active' })
  await db.recursiveDelete(db.collection('publishCommandStops'))
  await db.doc('locks/publish').delete()
  await db.recursiveDelete(db.collection('publishRecords'))
  await db.doc('reviewBatches/batch').set({ ...batch, env })
  await db.doc('curatorLive/publish-test/batchRevisions/batch').set({ revision: 2 })
  await db.doc('config/catalog').set({ version: 1 })
})

afterAll(async () => {
  await db.recursiveDelete(db.collection('publishCommands'))
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

test.each(['pause', 'revoke'])('Owner B explicitly adopts Owner A stopped upload after %s; old work loses the race', async reason => {
  const f = fixture()
  const deps = { ...f.deps, control, store, lock, records, pointer, curator: firestorePublishCurator(db, env) }
  let uploads = 0
  const upload = deps.snapshots.createOnly
  deps.snapshots.createOnly = async (...args) => {
    uploads++
    const result = await upload(...args)
    if (reason === 'pause') await control.change(true, controlActor, now)
    else await firestoreMembersStore(db).updateRoleGuarded('owner@example.com', 'editor')
    return result
  }
  expect(await publishBatch(deps, owner, command)).toEqual({ ok: false, error: reason === 'pause' ? 'paused' : 'revoked' })
  expect((await pointer.read()).version).toBe(1)
  const old = (await records.get(record.id))!
  const bytes = f.blobs.get(2)
  const actorB = { uid: 'backup', email: 'backup@example.com' }
  if (reason === 'pause') await control.change(false, actorB, now)
  const fresh = { ...command, commandId: 'fresh-b', generation: reason === 'pause' ? 3 : 1, requestedBy: { ...actorB, authorityEpoch: 0 } }
  const adopt = records.adopt
  deps.records = { ...records, adopt: async (...args) => {
    const adopted = await adopt(...args)
    expect(typeof adopted).toBe('object')
    expect(await pointer.advance(old, { ...lease, token: args[3] }, now)).toBe('superseded')
    expect(await records.save(old, args[3], now)).toBe(false)
    expect(await publishBatch(deps, owner, command)).toEqual({ ok: false, error: 'superseded' })
    return adopted
  } }
  expect(await publishBatch(deps, { ...owner, uid: 'backup' }, fresh)).toMatchObject({ ok: true, value: { toVersion: 2, commandId: 'fresh-b', requestedBy: fresh.requestedBy, supersededCommands: [expect.objectContaining({ commandId: command.commandId })] } })
  expect(await publishBatch(deps, { ...owner, uid: 'backup' }, fresh)).toMatchObject({ ok: true, value: { toVersion: 2 } })
  expect((await pointer.read()).version).toBe(2)
  expect(uploads).toBe(1)
  expect(f.blobs.get(2)).toBe(bytes)
})

test.each(['bytes', 'head', 'approval', 'stop'])('Firestore adoption rechecks %s transactionally', async changed => {
  await lock.claim(lease, now)
  await records.save(record, lease.token, now)
  await db.doc(`publishCommandStops/${command.commandId}`).set({ reason: 'paused' })
  if (changed === 'head') await db.doc('config/catalog').set({ version: 3 })
  if (changed === 'approval') await db.doc('reviewBatches/batch').update({ approval: null })
  if (changed === 'stop') await db.doc(`publishCommandStops/${command.commandId}`).delete()
  const result = await records.adopt(record, { ...command, commandId: 'fresh' }, changed === 'bytes' ? 'wrong' : record.blobSha256, lease.token, now)
  expect(result).toBe(changed === 'bytes' ? 'version_taken' : changed === 'head' ? 'stale_baseline' : changed === 'approval' ? 'superseded_revision' : 'superseded')
  expect((await records.get(record.id))?.commandId).toBe(command.commandId)
  expect((await pointer.read()).version).toBe(changed === 'head' ? 3 : 1)
})

test('concurrent duplicate command acceptance binds one immutable identity and run', async () => {
  const fresh = { ...command, commandId: 'fresh-accepted' }
  expect(await Promise.all([records.accept(fresh, now), records.accept(fresh, now)])).toEqual([{ ok: true, command: fresh }, { ok: true, command: fresh }])
  expect(await records.bindRun(fresh, 'one-run', now)).toBe(true)
  expect(await records.bindRun(fresh, 'other-run', now)).toBe(false)
  expect(await records.command(fresh.commandId)).toEqual({ command: fresh, runId: 'one-run' })
  expect(await store.getBatch(batch.id)).toMatchObject({ approvalRun: { runId: 'one-run', revision: 1 }, publishRequestedBy: fresh.requestedBy })
  expect(await records.accept({ ...fresh, requestedBy: { ...fresh.requestedBy, uid: 'other' } }, now)).toEqual({ ok: false, error: 'superseded' })
  expect(await records.accept({ ...fresh, commandId: 'another-click' }, now)).toEqual({ ok: false, error: 'locked' })
})

test.each(['revoke', 'pause', 'approval', 'revision', 'baseline'])('fresh command acceptance rechecks %s before storing it', async changed => {
  if (changed === 'revoke') await firestoreMembersStore(db).updateRoleGuarded('owner@example.com', 'editor')
  if (changed === 'pause') await control.change(true, controlActor, now)
  if (changed === 'approval') await db.doc('reviewBatches/batch').update({ approval: null })
  if (changed === 'revision') await db.doc('reviewBatches/batch').update({ revision: 3 })
  if (changed === 'baseline') await db.doc('config/catalog').set({ version: 2 })
  const fresh = { ...command, commandId: 'fresh-acceptance' }
  expect(await records.accept(fresh, now)).toEqual({ ok: false, error: changed === 'revoke' ? 'revoked' : changed === 'pause' ? 'paused' : changed === 'baseline' ? 'stale_baseline' : 'superseded_revision' })
  expect(await records.command(fresh.commandId)).toBeNull()
})

test('run metadata still binds if the fresh workflow finished before start returned', async () => {
  const fresh = { ...command, commandId: 'fast-run' }
  expect(await records.accept(fresh, now)).toEqual({ ok: true, command: fresh })
  const f = fixture()
  expect(await publishBatch({ ...f.deps, control, store, lock, records, pointer, curator: firestorePublishCurator(db, env) }, owner, fresh)).toMatchObject({ ok: true })
  expect(await records.bindRun(fresh, 'finished-run', now)).toBe(true)
  expect(await store.getBatch(batch.id)).toMatchObject({ state: 'published', approvalRun: { runId: 'finished-run', revision: 1 } })
})

test('replaying a prior run cannot replace the latest retry metadata; a newer revision is independent', async () => {
  const first = { ...command, commandId: 'first-click' }
  const second = { ...command, commandId: 'second-click' }
  expect(await records.accept(first, now)).toEqual({ ok: true, command: first })
  await db.doc('publishCommandStops/first-click').set({ reason: 'paused' })
  expect(await records.accept(second, now)).toEqual({ ok: true, command: second })
  await records.bindRun(second, 'second-run', now)
  await records.bindRun(first, 'old-run', now)
  expect(await store.getBatch(batch.id)).toMatchObject({ approvalRun: { runId: 'second-run' } })
  await db.doc('reviewBatches/batch').update({ revision: 4, approval: { revision: 3, by: 'owner', at: now } })
  const revised = { ...command, revision: 4, commandId: 'revised' }
  expect(await records.accept(revised, now)).toEqual({ ok: true, command: revised })
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
  expect(await records.save({ ...record, requestedBy: { ...command.requestedBy, authorityEpoch: 2 } }, lease.token, now)).toBe(false)
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
  expect((await db.doc(`publishCommandStops/${command.commandId}`).get()).exists).toBe(false)
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

test('control check for a committed command returns null without creating a stop', async () => {
  await lock.claim(lease, now)
  await records.save(record, lease.token, now)
  expect(await pointer.advance(record, lease, now)).toBe('advanced')
  await control.change(true, controlActor, now)
  expect(await control.check(command, now)).toBeNull()
  expect((await db.doc(`publishCommandStops/${command.commandId}`).get()).exists).toBe(false)
})

test('control check stamps a stop with the supplied clock', async () => {
  await control.change(true, controlActor, now)
  expect(await control.check(command, now)).toBe('paused')
  expect((await db.doc(`publishCommandStops/${command.commandId}`).get()).get('stoppedAt')).toBe(now)
})

test('Pause of a missing control reports not enabled without creating it', async () => {
  await db.doc('config/publishControl').delete()
  expect(await control.change(true, controlActor, now)).toBe('publish_not_enabled')
  expect((await db.doc('config/publishControl').get()).exists).toBe(false)
})

test('the pause transaction normalizes the membership email', async () => {
  expect(await control.change(true, { ...controlActor, email: ' Owner@Example.com ' }, now)).toMatchObject({ paused: true, generation: 2 })
})


test.each(['updateRoleGuarded', 'removeGuarded'] as const)('requester %s wins at the commit seam and restore cannot revive it', async method => {
  const members = firestoreMembersStore(db)
  const f = fixture()
  const deps = { ...f.deps, control, store, lock, records, pointer: { ...pointer, advance: async (...args: Parameters<typeof pointer.advance>) => {
    expect(await members[method]('owner@example.com', 'editor')).toBe('ok')
    return pointer.advance(...args)
  } }, curator: firestorePublishCurator(db, env) }
  expect(await publishBatch(deps, owner, command)).toEqual({ ok: false, error: 'revoked' })
  expect((await pointer.read()).version).toBe(1)
  expect(await records.get(record.id)).toMatchObject({ state: 'uploaded' })
  if (method === 'removeGuarded') {
    expect(await members.create({ email: 'owner@example.com', role: 'editor', signIn: 'google', invitedBy: 'backup', invite: { tokenHash: 'restore', issuedAt: now, expiresAt: '2027-11-15T12:00:00Z' } })).toBe('ok')
    expect(await members.activate('owner@example.com', 'owner')).toBe('ok')
  }
  expect(await members.updateRoleGuarded('owner@example.com', 'owner')).toBe('ok')
  expect(await publishBatch(deps, owner, command)).toEqual({ ok: false, error: 'revoked' })
})


test('revocation after Publish commit reconciles the same version exactly once', async () => {
  const f = fixture()
  let advances = 0
  const deps = { ...f.deps, control, store, lock, records, pointer: { ...pointer, advance: async (...args: Parameters<typeof pointer.advance>) => {
    advances++
    expect(await pointer.advance(...args)).toBe('advanced')
    expect(await firestoreMembersStore(db).removeGuarded('owner@example.com')).toBe('ok')
    expect(await pointer.advance(...args)).toBe('advanced')
    throw new Error('lost response')
  } }, curator: firestorePublishCurator(db, env) }
  expect(await publishBatch(deps, owner, command)).toMatchObject({ error: 'unavailable' })
  expect(await publishBatch(deps, owner, command)).toMatchObject({ ok: true, value: { toVersion: 2 } })
  expect(await publishBatch(deps, owner, command)).toMatchObject({ ok: true, value: { toVersion: 2 } })
  expect(advances).toBe(1)
  expect((await pointer.read()).version).toBe(2)
})

test('revocation before preparation refuses upload; restored authority still invalidates the old command', async () => {
  const members = firestoreMembersStore(db)
  await members.updateRoleGuarded('owner@example.com', 'editor')
  await members.updateRoleGuarded('owner@example.com', 'owner')
  const f = fixture()
  const deps = { ...f.deps, control, store, lock, records, pointer }
  expect(await publishBatch(deps, owner, command)).toEqual({ ok: false, error: 'revoked' })
  expect(f.blobs.has(2)).toBe(false)
})

test('a different revoked approver does not change requester authority or approval', async () => {
  const approved = { ...batch, approval: { revision: 1, by: 'approver', at: now } }
  await db.doc('reviewBatches/batch').set({ ...approved, env })
  const members = firestoreMembersStore(db)
  await members.upsertSeed({ email: 'approver@example.com', uid: 'approver', role: 'owner', status: 'active', signIn: 'google', invite: null, invitedBy: null, createdAt: now })
  expect(await members.removeGuarded('approver@example.com')).toBe('ok')
  const f = fixture(approved)
  expect(await publishBatch({ ...f.deps, control, store, lock, records, pointer, curator: firestorePublishCurator(db, env) }, owner, command)).toMatchObject({ ok: true })
  expect((await store.getBatch(batch.id))?.approval).toEqual(approved.approval)
  await db.doc('members/approver%40example.com').delete()
})

test.each([false, true])('a command with no authority marker is superseded at the pointer transaction (paused: %s)', async paused => {
  await db.doc('config/publishControl').set({ ...enabled, paused })
  const { requestedBy, ...legacy } = record
  expect(requestedBy).toBeDefined()
  await lock.claim(lease, now)
  await records.save(legacy, lease.token, now)
  expect(await pointer.advance(legacy, lease, now)).toBe('superseded')
  expect((await pointer.read()).version).toBe(1)
})

test.each(['pause', 'revoke'])('pause plus revoke preserves the first terminal reason: %s', async first => {
  if (first === 'pause') await control.change(true, controlActor, now)
  else await firestoreMembersStore(db).updateRoleGuarded('owner@example.com', 'editor')
  const expected = first === 'pause' ? 'paused' : 'revoked'
  expect(await control.check(command, now)).toBe(expected)
  await db.doc('config/publishControl').set({ ...enabled, paused: true, generation: 2 })
  await firestoreMembersStore(db).updateRoleGuarded('owner@example.com', 'editor')
  expect(await control.check(command, now)).toBe(expected)
  expect((await pointer.read()).version).toBe(1)
})


test('bootstrap without a member document fails the final active Owner check', async () => {
  await lock.claim(lease, now)
  await records.save(record, lease.token, now)
  await db.doc('members/owner%40example.com').delete()
  expect(await pointer.advance(record, lease, now)).toBe('revoked')
  expect((await pointer.read()).version).toBe(1)
})


test('an unchanged guarded Owner role preserves an in-flight Publish at the commit seam', async () => {
  const f = fixture()
  const deps = { ...f.deps, control, store, lock, records, pointer: { ...pointer, advance: async (...args: Parameters<typeof pointer.advance>) => {
    expect(await firestoreMembersStore(db).updateRoleGuarded('owner@example.com', 'owner')).toBe('ok')
    return pointer.advance(...args)
  } }, curator: firestorePublishCurator(db, env) }
  expect(await publishBatch(deps, owner, command)).toMatchObject({ ok: true, value: { toVersion: 2 } })
})

test('guarded demotion then restore before the pointer transaction invalidates the old epoch', async () => {
  const f = fixture()
  const members = firestoreMembersStore(db)
  const deps = { ...f.deps, control, store, lock, records, pointer: { ...pointer, advance: async (...args: Parameters<typeof pointer.advance>) => {
    expect(await members.updateRoleGuarded('owner@example.com', 'editor')).toBe('ok')
    expect(await members.updateRoleGuarded('owner@example.com', 'owner')).toBe('ok')
    return pointer.advance(...args)
  } }, curator: firestorePublishCurator(db, env) }
  expect(await publishBatch(deps, owner, command)).toEqual({ ok: false, error: 'revoked' })
  expect((await pointer.read()).version).toBe(1)
})
