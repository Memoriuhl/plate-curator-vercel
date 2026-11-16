import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, expect, test } from 'vitest'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import type { ProposedEdit, ReviewBatch } from '../lib/review/types'
import { reviewBatchScenarios } from '../tests/review/batch-scenarios'
import { reviewQueryScenarios } from '../tests/review/query-scenarios'
import { db } from './setup'

const env = 'preview-test'
const store = firestoreReviewStore(db, env)
const batch: ReviewBatch = { id: 'batch', name: 'Review plates', createdBy: 'editor', createdAt: '2026-11-15T12:00:00Z', state: 'open', revision: 4, baselineVersion: 1, plateIds: ['one', 'two'], approval: null }
const edit: ProposedEdit = { plateId: 'one', baseRevision: 'before', fields: { tags: ['changed'] }, authorId: 'editor', updatedAt: '2026-11-15T12:00:00Z', resultRevision: 'after' }

beforeEach(async () => {
  await db.recursiveDelete(db.collection('reviewBatches'))
  await db.doc('reviewBatches/batch').set({ ...batch, env })
})

afterAll(async () => {
  await db.recursiveDelete(db.collection('reviewBatches'))
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
