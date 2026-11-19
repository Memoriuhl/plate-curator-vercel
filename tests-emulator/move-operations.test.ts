import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { moveState } from '../lib/review/move-state'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import type { Plate } from '../lib/catalog/types'
import type { Actor, ReviewBatch, ReviewDeps } from '../lib/review/types'
import { db } from './setup'

test('concurrent state moves retry against Firestore and retain both placements', async () => {
  const batchId = 'draft~move-' + randomUUID()
  const store = firestoreReviewStore(db, batchId)
  const plates: Plate[] = ['a', 'b', 'c', 'd', 'e'].map((slug) => ({
    id: 'AK.' + slug,
    state: 'AK',
    slug,
    displayName: slug,
    image: '',
    tags: [],
    templateRole: 'template',
    isStandard: slug === 'a',
  }))
  const batch: ReviewBatch = {
    id: batchId,
    kind: 'shared-draft',
    revision: 12,
    rebaseFloor: 12,
    baselineVersion: 1,
    name: 'Working draft',
    state: 'open',
    createdBy: 'one',
    createdByName: null,
    createdAt: '',
    plateIds: [],
    stateOrders: {},
    approval: null,
  }
  const deps: ReviewDeps = {
    store,
    stateBaseline: async () => plates,
    baseline: async () => null,
    baselineAtVersion: async () => null,
    now: () => '2026-11-18T22:10:00Z',
  }
  await store.create(batch)
  let reads = 0
  let release!: () => void
  const bothRead = new Promise<void>((resolve) => {
    release = resolve
  })
  const readBatch = store.readBatch
  store.readBatch = async (id) => {
    const detail = await readBatch(id)
    if (++reads === 2) release()
    if (reads <= 2) await bothRead
    return detail
  }
  const commit = store.commit
  let firstCommit: Promise<Awaited<ReturnType<typeof commit>>> | undefined
  store.commit = async (...args) => {
    if (firstCommit) await firstCommit
    const result = commit(...args)
    firstCommit ??= result
    return result
  }
  const move = (uid: string, plateId: string, anchorId: string) => {
    const actor: Actor = { uid, name: uid, role: 'editor' }
    return moveState(deps, actor, {
      batchId,
      state: 'AK',
      moves: [{ plateIds: [plateId], placement: { kind: 'before', anchorId } }],
    })
  }
  try {
    const results = await Promise.all([
      move('one', 'AK.e', 'AK.c'),
      move('two', 'AK.d', 'AK.b'),
    ])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(await store.getBatch(batchId)).toMatchObject({
      revision: 14,
      stateOrders: { AK: ['AK.a', 'AK.d', 'AK.b', 'AK.e', 'AK.c'] },
    })
    expect(reads).toBeGreaterThan(2)
  } finally {
    await db.recursiveDelete(db.doc('reviewBatches/' + batchId))
  }
})
