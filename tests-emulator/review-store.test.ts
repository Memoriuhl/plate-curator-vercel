import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { approveBatch, proposeEdit, reorderState, submitBatch } from '../lib/review/batch'
import { plateRevision } from '../lib/review/revision'
import { seedDemo } from '../lib/review/demo-seed'
import { liveEnvKey, signalPath } from '../lib/review/live-signal'
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

test.each(['development', 'preview:feature/demo'])('demo seed and resets keep the signal scoped to %s at the draft revision', async demoEnv => {
  const demoStore = firestoreReviewStore(db, demoEnv)
  const editor = { uid: 'demo-editor', name: 'Demo Editor', role: 'editor' } as const
  const plates = [
    { ...snapshot.plates[0], state: 'AK', templateRole: 'template' as const, templateFamily: 'gold' },
    { ...snapshot.plates[1], state: 'AK', templateRole: 'template' as const, templateFamily: 'bear' },
    { ...snapshot.plates[1], id: 'variant', state: 'AK', templateRole: 'variant' as const, templateFamily: 'bear', variantOfPlateId: 'two' },
  ]
  const deps = { ...fixture().deps, store: demoStore, baseline: async (id: string) => plates.find(plate => plate.id === id) ?? null, baselineAtVersion: async (_version: number, id: string) => plates.find(plate => plate.id === id) ?? null, stateBaseline: async () => plates }
  const input = { projectId: 'license-plate-game-staging', env: demoEnv, editor, version: 1 }
  const assertSignal = async (batch: ReviewBatch) => {
    const saved = await db.runTransaction(async tx => {
      const draft = await tx.get(db.doc(`reviewBatches/${batch.id}`))
      const signal = await tx.get(db.doc(signalPath(liveEnvKey(demoEnv), batch.id)))
      return { draft: draft.data(), signal: signal.data() }
    }, { readOnly: true })
    expect(saved.draft).toEqual({ ...batch, env: demoEnv })
    expect(saved.signal).toEqual({ revision: batch.revision })
    const otherEnv = demoEnv === 'development' ? 'preview:feature/demo' : 'development'
    expect((await db.doc(signalPath(liveEnvKey(otherEnv), batch.id)).get()).exists).toBe(false)
  }
  let current = await seedDemo(deps, input)
  await assertSignal(current)
  const seededEdits = await demoStore.listEdits(current.id)
  for (const state of ['open', 'edited', 'submitted', 'approved'] as const) {
    if (state !== 'open') {
      expect(await proposeEdit(deps, editor, { batchId: current.id, plateId: 'two', baseRevision: plateRevision(plates[1]), fields: { tags: ['changed'] } })).toMatchObject({ ok: true })
      current = (await demoStore.getBatch(current.id))!
    }
    if (state === 'submitted' || state === 'approved') {
      expect(await submitBatch(deps, editor, current.id, current.revision)).toMatchObject({ ok: true })
      current = (await demoStore.getBatch(current.id))!
    }
    if (state === 'approved') {
      expect(await approveBatch(deps, owner, current.id, current.revision)).toMatchObject({ ok: true })
      current = (await demoStore.getBatch(current.id))!
    }
    const reset = await seedDemo(deps, input)
    expect(reset.revision).toBeGreaterThan(current.revision)
    expect(reset).toMatchObject({ state: 'open', approval: null })
    await assertSignal(reset)
    expect(await demoStore.listEdits(reset.id)).toEqual(seededEdits)
    current = reset
  }
  const before = await demoStore.readBatch(current.id)
  const rejectedStore = { ...demoStore, commit: async (...args: Parameters<typeof demoStore.commit>) => demoStore.commit(args[0], args[1] - 1, args[2]) }
  await expect(seedDemo({ ...deps, store: rejectedStore }, input)).rejects.toThrow('Demo batch changed during reset')
  expect(await demoStore.readBatch(current.id)).toEqual(before)
  await assertSignal(current)
})

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

test.each(['success', 'competing tag', 'other batch'] as const)('combined promotion and signal transaction: %s', async scenario => {
  const variant = { ...snapshot.plates[0], id: 'one', state: 'AK', templateRole: 'variant' as const, templateFamily: 'old', variantOfPlateId: 'two' }
  const parent = { ...variant, id: 'two', templateRole: 'template' as const, templateFamily: 'parent' }
  const approval = { revision: 3, by: owner.uid, at: '' }
  await db.doc('reviewBatches/batch').set({ ...batch, state: 'approved', approval, env })
  await db.doc(`curatorLive/${env}/batchRevisions/batch`).set({ revision: 4 })
  const deps = { store, baseline: async () => variant, baselineAtVersion: async () => variant, stateBaseline: async () => [variant, parent], now: () => '' }
  const commit = store.commit.bind(store)
  const racingStore = { ...store, commit: async (...args: Parameters<typeof store.commit>) => {
    if (scenario === 'competing tag') {
      expect((await proposeEdit(deps, owner, { batchId: 'batch', plateId: 'two', baseRevision: plateRevision(variant), fields: { tags: ['remote'] } })).ok).toBe(true)
    } else if (scenario === 'other batch') {
      await store.create({ ...batch, id: 'other' })
      expect(await commit('other', 4, { batch: { ...batch, id: 'other', revision: 5 } })).toBe('ok')
    }
    return commit(...args)
  } }
  const result = await reorderState({ ...deps, store: racingStore }, owner, { batchId: 'batch', state: 'AK', batchRevision: 4, order: ['two', 'one'], promotion: { plateId: 'one', templateFamily: 'new' } })
  const saved = await db.runTransaction(async transaction => {
    const draft = await transaction.get(db.doc('reviewBatches/batch'))
    const edits = await transaction.get(db.collection('reviewBatches/batch/edits'))
    const signal = await transaction.get(db.doc(`curatorLive/${env}/batchRevisions/batch`))
    return { batch: draft.data(), edits: edits.docs.map(doc => doc.data()), signal: signal.data() }
  })
  expect(saved.batch).toMatchObject({ revision: 5, approval: null })
  expect(saved.signal).toEqual({ revision: 5 })
  if (scenario === 'competing tag') {
    expect(result).toEqual({ ok: false, error: 'superseded_revision' })
    expect(saved.batch?.stateOrders).toEqual({})
    expect(saved.edits).toMatchObject([{ plateId: 'two', fields: { tags: ['remote'] } }])
    expect(await store.getEdit('batch', 'one')).toBeNull()
  } else {
    expect(result.ok).toBe(true)
    expect(saved.batch?.stateOrders).toEqual({ AK: ['two', 'one'] })
    expect(saved.edits).toMatchObject([{ plateId: 'one', fields: { templateRole: 'template', templateFamily: 'new', variantOfPlateId: null } }])
  }
})

test('reserved Batch rejects a combined move without clearing approval or changing the signal', async () => {
  const variant = { ...snapshot.plates[0], id: 'one', state: 'AK', templateRole: 'variant' as const }
  const approved = { ...batch, state: 'approved', approval: { revision: 3, by: owner.uid, at: '' }, env, publishReservation: { token: 'reserved', recordId: 'missing' } }
  await db.doc('reviewBatches/batch').set(approved)
  const signal = db.doc(`curatorLive/${env}/batchRevisions/batch`)
  await signal.set({ revision: 4 })
  const result = await reorderState({ ...fixture().deps, store, baseline: async () => variant, stateBaseline: async () => [variant] }, owner, { batchId: 'batch', state: 'AK', batchRevision: 4, order: ['one'], promotion: { plateId: 'one', templateFamily: 'new' } })
  expect(result).toEqual({ ok: false, error: 'superseded_revision' })
  expect((await db.doc('reviewBatches/batch').get()).data()).toEqual(approved)
  expect((await signal.get()).data()).toEqual({ revision: 4 })
  expect(await store.listEdits('batch')).toEqual([])
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
