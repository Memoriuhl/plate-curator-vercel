import { afterAll, beforeEach, expect, test } from 'vitest'
import { firestoreBatchSignalsBackfillStore } from '../lib/review/signals/firestore-backfill-signals'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import { db } from './setup'

beforeEach(async () => {
  await db.recursiveDelete(db.collection('reviewBatches'))
  await db.recursiveDelete(db.collection('curatorLive'))
})
afterAll(async () => {
  await db.recursiveDelete(db.collection('reviewBatches'))
  await db.recursiveDelete(db.collection('curatorLive'))
  await db.terminate()
})

test('transaction initializes missing signals from the current batch and preserves existing signals', async () => {
  const store = firestoreBatchSignalsBackfillStore(db)
  await db
    .doc('reviewBatches/legacy')
    .set({ env: 'preview:feat/x', revision: 6 })
  await db.doc('reviewBatches/other').set({ env: 'development', revision: 9 })
  expect(await store.listBatchIds('preview:feat/x')).toEqual(['legacy'])
  expect(await store.initializeMissing('other', 'preview:feat/x')).toBe(false)
  expect(await store.initializeMissing('missing', 'preview:feat/x')).toBe(false)
  expect(await store.initializeMissing('legacy', 'preview:feat/x')).toBe(true)
  const signal = db.doc('curatorLive/preview%3Afeat%2Fx/batchRevisions/legacy')
  expect((await signal.get()).data()).toEqual({ revision: 6 })
  await db.doc('reviewBatches/legacy').update({ revision: 7 })
  expect(await store.initializeMissing('legacy', 'preview:feat/x')).toBe(false)
  expect((await signal.get()).data()).toEqual({ revision: 6 })
})

test('concurrent commit and backfill cannot overwrite the committed signal', async () => {
  const batch = {
    id: 'race',
    name: '',
    createdBy: 'editor',
    createdByName: null,
    createdAt: '',
    state: 'open' as const,
    revision: 4,
    baselineVersion: 1,
    stateOrders: {},
    plateIds: [],
    approval: null,
  }
  await db.doc('reviewBatches/race').set({ ...batch, env: 'development' })
  await Promise.all([
    firestoreBatchSignalsBackfillStore(db).initializeMissing(
      'race',
      'development'
    ),
    firestoreReviewStore(db, 'development').commit('race', 4, {
      batch: { ...batch, revision: 5 },
    }),
  ])
  expect(
    (await db.doc('curatorLive/development/batchRevisions/race').get()).data()
  ).toEqual({ revision: 5 })
}, 30000)
