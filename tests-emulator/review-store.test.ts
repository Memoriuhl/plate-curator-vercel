import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { approveBatch, proposeEdit, reorderState, submitBatch } from '../lib/review/batch'
import { plateRevision } from '../lib/review/revision'
import { fixture, owner, snapshot } from '../tests/publish/fixture'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import type { ProposedEdit, ReviewBatch } from '../lib/review/types'
import { reviewBatchScenarios } from '../tests/review/batch-scenarios'
import { reviewQueryScenarios } from '../tests/review/query-scenarios'
import { db } from './setup'

const env = 'preview-test'
const store = firestoreReviewStore(db, env)
const batch: ReviewBatch = {
  stateOrders: {}, id: 'batch', name: 'Review plates', createdBy: 'editor', createdByName: null, createdAt: '2026-11-15T12:00:00Z', state: 'open', revision: 4, baselineVersion: 1, plateIds: ['one', 'two'], approval: null }
const edit: ProposedEdit = { plateId: 'one', baseRevision: 'before', fields: { tags: ['changed'] }, authorId: 'editor', updatedAt: '2026-11-15T12:00:00Z', resultRevision: 'after' }

beforeEach(async () => {
  await db.recursiveDelete(db.collection('reviewBatches'))
  await db.recursiveDelete(db.collection('curatorLive'))
  await db.doc('reviewBatches/batch').set({ ...batch, env })
})

afterAll(async () => {
  await db.recursiveDelete(db.collection('reviewBatches'))
  await db.recursiveDelete(db.collection('curatorLive'))
  await db.terminate()
})

reviewBatchScenarios(async seed => {
  await db.doc(`reviewBatches/${seed.id}`).set({ ...seed, env })
  return firestoreReviewStore(db, env)
})

test('commit refuses a stale expected revision', async () => {
  expect(await store.commit('batch', 3, { batch: { ...batch, revision: 5 }, edit })).toBe('revision_mismatch')
  expect(await store.getBatch('batch')).toEqual(batch)
  expect(await store.getEdit('batch', 'one')).toBeNull()
})

test('commit writes batch and edit atomically', async () => {
  const candidates = ['one', 'two'].map(plateId => ({ ...edit, plateId }))
  const results = await Promise.all(candidates.map(proposal => store.commit('batch', 4, { batch: { ...batch, revision: 5 }, edit: proposal })))
  expect(results.filter(result => result === 'ok')).toHaveLength(1)
  const saved = await db.runTransaction(async transaction => {
    const batchDoc = await transaction.get(db.doc('reviewBatches/batch'))
    const edits = await transaction.get(db.collection('reviewBatches/batch/edits'))
    return { batch: batchDoc.data(), edits: edits.docs.map(doc => doc.data()) }
  })
  expect(saved.batch).toEqual({ ...batch, revision: 5, env })
  expect(saved.edits).toEqual([candidates[results.indexOf('ok')]])
})

test('a batch from another env is invisible', async () => {
  await db.doc('reviewBatches/batch/edits/one').set(edit)
  const otherStore = firestoreReviewStore(db, 'production')
  expect(await otherStore.getBatch('batch')).toBeNull()
  expect(await otherStore.readBatch('batch')).toBeNull()
  expect(await otherStore.getEdit('batch', 'one')).toBeNull()
  expect(await otherStore.listEdits('batch')).toEqual([])
  expect(await otherStore.commit('batch', 4, { batch: { ...batch, revision: 5 }, deleteEditFor: 'one' })).toBe('revision_mismatch')
  expect(await store.getBatch('batch')).toEqual(batch)
  expect(await store.getEdit('batch', 'one')).toEqual(edit)
})

test('deleteEditFor removes the edit', async () => {
  await store.commit('batch', 4, { batch: { ...batch, revision: 5 }, edit })
  expect(await store.commit('batch', 5, { batch: { ...batch, revision: 6 }, deleteEditFor: 'one' })).toBe('ok')
  expect(await store.getEdit('batch', 'one')).toBeNull()
  expect(await store.getBatch('batch')).toEqual({ ...batch, revision: 6 })
})

test('commit refuses a missing batch without creating documents', async () => {
  const id = randomUUID()
  expect(await store.commit(id, 4, { batch: { ...batch, id, revision: 5 }, edit })).toBe('revision_mismatch')
  expect(await store.getBatch(id)).toBeNull()
  expect((await db.doc(`reviewBatches/${id}/edits/one`).get()).exists).toBe(false)
})

test('a failed edit write leaves the batch unchanged', async () => {
  await expect(store.commit('batch', 4, {
    batch: { ...batch, revision: 5 }, edit: { ...edit, fields: { templateFamily: undefined } },
  })).rejects.toThrow()
  expect(await store.getBatch('batch')).toEqual(batch)
  expect(await store.getEdit('batch', 'one')).toBeNull()
})

reviewQueryScenarios(async () => {
  await db.recursiveDelete(db.collection('reviewBatches'))
  await db.recursiveDelete(db.collection('curatorLive'))
  return firestoreReviewStore(db, env)
})

test("list never returns another env's batches", async () => {
  const otherBatch = { ...batch, id: 'other', name: 'Other environment' }
  const otherStore = firestoreReviewStore(db, 'production')
  expect(await otherStore.create(otherBatch)).toBe('ok')
  expect(await store.list({})).toEqual([batch])
  expect(await store.list({ states: ['open'] })).toEqual([batch])
  expect(await otherStore.list({})).toEqual([otherBatch])
  expect(await store.create(otherBatch)).toBe('exists')
  expect(await otherStore.getBatch('other')).toEqual(otherBatch)
})


test('legacy batches read back with a null creator name without migration', async () => {
  const legacy = { ...batch, env }
  Reflect.deleteProperty(legacy, 'createdByName')
  Reflect.deleteProperty(legacy, 'stateOrders')
  await db.doc('reviewBatches/batch').set(legacy)
  expect(await store.getBatch('batch')).toEqual({ ...batch, createdByName: null })
  expect(await store.list({})).toEqual([{ ...batch, createdByName: null }])
  expect(await store.readBatch('batch')).toEqual({ batch: { ...batch, createdByName: null }, edits: [] })
  expect((await db.doc('reviewBatches/batch').get()).data()).not.toHaveProperty('createdByName')
  expect((await db.doc('reviewBatches/batch').get()).data()).not.toHaveProperty('stateOrders')
})

test('create initializes the revision signal and duplicate creation preserves it', async () => {
  const created = { ...batch, id: randomUUID(), revision: 0 }
  expect(await store.create(created)).toBe('ok')
  expect((await db.doc(`curatorLive/preview-test/batchRevisions/${created.id}`).get()).data()).toEqual({ revision: 0 })
  expect(await store.create({ ...created, revision: 10 })).toBe('exists')
  expect((await db.doc(`curatorLive/preview-test/batchRevisions/${created.id}`).get()).data()).toEqual({ revision: 0 })
})

test('signal and coherent draft advance together, including under concurrent reads', async () => {
  await db.doc('curatorLive/preview-test/batchRevisions/batch').set({ revision: 4 })
  for (let revision = 5; revision <= 8; revision += 1) {
    const [observed] = await Promise.all([
      db.runTransaction(async tx => {
        const batchDoc = await tx.get(db.doc('reviewBatches/batch'))
        const signal = await tx.get(db.doc('curatorLive/preview-test/batchRevisions/batch'))
        return [batchDoc.get('revision'), signal.get('revision')]
      }, { readOnly: true }),
      store.commit('batch', revision - 1, { batch: { ...batch, revision }, edit }),
    ])
    expect(observed[0]).toBe(observed[1])
  }
  expect(await store.readBatch('batch')).toEqual({ batch: { ...batch, revision: 8 }, edits: [edit] })
  expect((await db.doc('curatorLive/preview-test/batchRevisions/batch').get()).data()).toEqual({ revision: 8 })
})

test.each(['stale', 'reserved', 'wrong-env', 'invalid-write'])('%s rejection preserves both draft and signal', async reason => {
  const signal = db.doc('curatorLive/preview-test/batchRevisions/batch')
  await signal.set({ revision: 4 })
  if (reason === 'reserved') await db.doc('reviewBatches/batch').update({ publishReservation: { token: 'reserved', recordId: 'missing' } })
  const before = (await db.doc('reviewBatches/batch').get()).data()
  const committing = (reason === 'wrong-env' ? firestoreReviewStore(db, 'production') : store).commit('batch', reason === 'stale' ? 3 : 4, {
    batch: { ...batch, revision: 5 }, edit: reason === 'invalid-write' ? { ...edit, fields: { templateFamily: undefined } } : edit,
    ...(reason === 'reserved' ? { publishToken: 'reserved' } : {}),
  })
  if (reason === 'invalid-write') await expect(committing).rejects.toThrow()
  else expect(await committing).toBe('revision_mismatch')
  expect((await db.doc('reviewBatches/batch').get()).data()).toEqual(before)
  expect((await signal.get()).data()).toEqual({ revision: 4 })
  expect((await db.doc('curatorLive/production/batchRevisions/batch').get()).exists).toBe(false)
  expect(await store.getEdit('batch', 'one')).toBeNull()
})

async function lifecycleSnapshot() {
  return db.runTransaction(async tx => {
    const batchDoc = await tx.get(db.doc('reviewBatches/batch'))
    const signal = await tx.get(db.doc('curatorLive/preview-test/batchRevisions/batch'))
    const edits = await tx.get(db.collection('reviewBatches/batch/edits'))
    return { batch: batchDoc.data(), signal: signal.data(), edits: edits.docs.map(doc => doc.data()) }
  }, { readOnly: true })
}

test('submit, approve and an edit after approval commit their lifecycle state with the signal', async () => {
  await db.doc('curatorLive/preview-test/batchRevisions/batch').set({ revision: 4 })
  const supersedeRun = vi.fn(async () => {})
  const deps = { ...fixture().deps, store, supersedeRun }
  for (const [transition, state, revision] of [
    [() => submitBatch(deps, owner, 'batch', 4), 'submitted', 5],
    [() => approveBatch(deps, owner, 'batch', 5), 'approved', 6],
    [() => proposeEdit(deps, owner, { batchId: 'batch', plateId: 'one', baseRevision: plateRevision(snapshot.plates[0]), fields: { tags: ['after approval'] } }), 'open', 7],
  ] as const) {
    const [during, result] = await Promise.all([lifecycleSnapshot(), transition()])
    expect(result).toMatchObject({ ok: true })
    expect(during.batch?.revision).toBe(during.signal?.revision)
    expect(during.edits).toMatchObject(during.batch?.revision === 7 ? [{ fields: { tags: ['after approval'] } }] : [])
    const saved = await lifecycleSnapshot()
    expect(saved.batch).toMatchObject({ state, revision, approval: state === 'approved' ? { revision: 5, by: 'owner' } : null })
    expect(saved.signal).toEqual({ revision })
  }
  expect((await store.readBatch('batch'))?.edits).toMatchObject([{ plateId: 'one', fields: { tags: ['after approval'] } }])
  expect(supersedeRun).toHaveBeenCalledWith(expect.objectContaining({ state: 'approved', revision: 6 }))
})

test.each(['stale-submit', 'stale-order', 'forbidden-approve'] as const)('%s leaves the lifecycle draft and signal unchanged', async reason => {
  await db.doc('curatorLive/preview-test/batchRevisions/batch').set({ revision: 4 })
  const deps = { ...fixture().deps, store }
  const before = await lifecycleSnapshot()
  const result = reason === 'stale-submit'
    ? await submitBatch(deps, owner, 'batch', 3)
    : reason === 'stale-order'
      ? await reorderState(deps, owner, { batchId: 'batch', state: 'CA', batchRevision: 3, order: ['two', 'one'] })
      : await approveBatch(deps, { ...owner, role: 'editor' }, 'batch', 4)
  expect(result).toEqual({ ok: false, error: reason === 'forbidden-approve' ? 'forbidden' : 'superseded_revision' })
  expect(await lifecycleSnapshot()).toEqual(before)
})
