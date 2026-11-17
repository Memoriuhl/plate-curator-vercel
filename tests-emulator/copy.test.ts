import { afterAll, beforeEach, expect, test } from 'vitest'
import { copyBatch, copyBatchId, type CopyDeps } from '../lib/review/copy'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import { signalPath, liveEnvKey } from '../lib/review/live-signal'
import { batch, owner, snapshot } from '../tests/publish/fixture'
import { db } from './setup'

const env = 'copy-test'
const store = firestoreReviewStore(db, env)
const input = { sourceId: batch.id, sourceRevision: 2, targetVersion: 2 }
const targetId = copyBatchId(env, batch.id, 2, 2)
const copySnapshot = { ...snapshot, plates: snapshot.plates.map(plate => ({ ...plate, templateRole: 'template' as const, isStandard: plate.id === 'two' })) }
const d: CopyDeps = { env, store, now: () => '2026-11-16T12:00:00Z', head: async () => (await db.doc('config/catalog').get()).get('version'), snapshot: async () => ({ ...copySnapshot, version: 2 }) }
beforeEach(async () => {
  await db.recursiveDelete(db.collection('reviewBatches'))
  await db.recursiveDelete(db.collection('publishRecords'))
  await db.doc(signalPath(liveEnvKey(env), targetId)).delete()
  await db.doc('reviewBatches/batch').set({ ...batch, stateOrders: { CA: ['two', 'one'] }, env })
  await db.doc('reviewBatches/batch/edits/one').set({ plateId: 'one', fields: { tags: ['proposal'], variantOfPlateId: null }, baseRevision: 'old', resultRevision: 'old', authorId: 'editor', updatedAt: '' })
  await db.doc('config/catalog').set({ version: 2 })
})
afterAll(async () => {
  await db.recursiveDelete(db.collection('reviewBatches'))
  await db.recursiveDelete(db.collection('publishRecords'))
  await db.recursiveDelete(db.collection(`curatorLive/${liveEnvKey(env)}/batchRevisions`))
  await db.doc('config/catalog').delete()
  await db.terminate()
})

test('concurrent copies commit one complete Batch, edits and initial live revision signal', async () => {
  const before = await store.readBatch(batch.id)
  const results = await Promise.all(Array.from({ length: 4 }, () => copyBatch(d, owner, input)))
  expect(results.every(result => result.ok && result.value.id === targetId)).toBe(true)
  expect(await store.list({})).toHaveLength(2)
  expect(await store.readBatch(targetId)).toMatchObject({ batch: { state: 'open', revision: 0, approval: null, createdBy: owner.uid, source: { batchId: batch.id, revision: 2 } }, edits: [{ fields: { tags: ['proposal'], variantOfPlateId: null }, baseRevision: expect.not.stringMatching(/^old$/) }] })
  expect((await db.doc(signalPath(liveEnvKey(env), targetId)).get()).data()).toEqual({ revision: 0 })
  expect(await store.readBatch(batch.id)).toEqual(before)
  await db.doc('config/catalog').set({ version: 3 })
  expect(await copyBatch(d, owner, input)).toEqual(results[0])
})

test.each(['head', 'revision', 'status', 'environment', 'reservation', 'committed receipt'])('transaction rejects concurrent %s change without a target or signal', async kind => {
  const raced: CopyDeps = { ...d, snapshot: async () => {
    if (kind === 'head') await db.doc('config/catalog').set({ version: 3 })
    if (kind === 'revision') await db.doc('reviewBatches/batch').update({ revision: 3 })
    if (kind === 'status') await db.doc('reviewBatches/batch').update({ state: 'published' })
    if (kind === 'environment') await db.doc('reviewBatches/batch').update({ env: 'other' })
    if (kind === 'reservation') await db.doc('reviewBatches/batch').update({ publishReservation: { token: 'busy' } })
    if (kind === 'committed receipt') await db.doc('publishRecords/batch@2').set({ committedAt: 'now', env })
    return { ...copySnapshot, version: 2 }
  } }
  const result = await copyBatch(raced, owner, input)
  expect(result).toMatchObject({ ok: false, error: kind === 'head' ? 'head_moved' : kind === 'revision' ? 'superseded_revision' : kind === 'environment' ? 'not_found' : 'invalid_state' })
  expect((await db.doc(`reviewBatches/${targetId}`).get()).exists).toBe(false)
  expect((await db.doc(signalPath(liveEnvKey(env), targetId)).get()).exists).toBe(false)
})

test('foreign environment cannot read or copy the source', async () => {
  const foreign = firestoreReviewStore(db, 'other')
  expect(await foreign.readBatch(batch.id)).toBeNull()
  expect(await copyBatch({ ...d, env: 'other', store: foreign }, owner, input)).toEqual({ ok: false, error: 'not_found' })
})

test('incompatible inventory produces no Batch, edits or signal', async () => {
  const incompatible = { ...d, snapshot: async () => ({ version: 2, plates: [snapshot.plates[1]] }) }
  expect(await copyBatch(incompatible, owner, input)).toMatchObject({ ok: false, error: 'incompatible' })
  expect((await db.doc(`reviewBatches/${targetId}`).get()).exists).toBe(false)
  expect((await db.doc(signalPath(liveEnvKey(env), targetId)).get()).exists).toBe(false)
})

test('a copy transaction replay survives source revision and state changes', async () => {
  const copied = await copyBatch(d, owner, input)
  expect(copied.ok).toBe(true)
  if (!copied.ok) return
  await db.doc('reviewBatches/batch').update({ state: 'open', revision: 3, approval: null })
  expect(await copyBatch(d, owner, input)).toEqual(copied)
  expect(await store.copy({ ...input, batch: copied.value, edits: [] })).toEqual(copied)
})
