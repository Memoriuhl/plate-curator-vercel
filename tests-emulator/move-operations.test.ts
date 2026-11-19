import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, test } from 'vitest'
import { moveState } from '../lib/review/move-state'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import type { Plate } from '../lib/catalog/types'
import type { Actor, ReviewBatch, ReviewDeps } from '../lib/review/types'
import { db } from './setup'

async function fixture() {
  const batchId = 'draft~move-' + randomUUID()
  const store = firestoreReviewStore(db, batchId)
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
    stateBaseline: async (_, state) =>
      ['a', 'b', 'c', 'd', 'e'].map((slug): Plate => ({
        id: `${state}.${slug}`,
        state,
        slug,
        displayName: slug,
        image: '',
        tags: [],
        templateRole: 'template',
        isStandard: slug === 'a',
      })),
    baseline: async () => null,
    baselineAtVersion: async () => null,
    now: () => '2026-11-18T22:10:00Z',
  }
  await store.create(batch)
  const move = (
    state: string,
    plate: string,
    anchor: string,
    withDeps = deps,
    operationId = randomUUID()
  ) => {
    const actor: Actor = { uid: plate, name: plate, role: 'editor' }
    const input = {
      batchId,
      operationId,
      state,
      moves: [
        {
          plateIds: [`${state}.${plate}`],
          placement: {
            kind: 'before' as const,
            anchorId: `${state}.${anchor}`,
          },
        },
      ],
    }
    return moveState(withDeps, actor, input)
  }
  return {
    batchId,
    store,
    deps,
    move,
    cleanup: () => db.recursiveDelete(db.doc('reviewBatches/' + batchId)),
  }
}

test('same-state placements at one anchor follow arrival order even when the first read pauses', async () => {
  const { batchId, store, deps, move, cleanup } = await fixture()
  const baseline = deps.stateBaseline
  const paused = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let firstRead = true
  deps.stateBaseline = async (...args) => {
    if (firstRead) {
      firstRead = false
      paused.resolve()
      await resume.promise
    }
    return baseline(...args)
  }
  try {
    const operationId = randomUUID()
    const first = move('AK', 'd', 'b', deps, operationId)
    await paused.promise
    const second = move('AK', 'e', 'b', {
      ...deps,
      store: firestoreReviewStore(db, batchId),
    })
    await Promise.race([second, delay(1000)])
    resume.resolve()
    const results = await Promise.all([first, second])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(await move('AK', 'd', 'b', deps, operationId)).toEqual(results[0])
    expect(await store.getBatch(batchId)).toMatchObject({
      revision: 14,
      stateOrders: { AK: ['AK.a', 'AK.d', 'AK.e', 'AK.b', 'AK.c'] },
    })
  } finally {
    resume.resolve()
    await cleanup()
  }
})

test('a continuous stream of Alabama placements cannot exhaust an Alaska move at the commit boundary', async () => {
  const { batchId, store, deps, move, cleanup } = await fixture()
  const other = { ...deps, store: firestoreReviewStore(db, batchId) }
  const commit = store.commit
  const paused = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const baseline = deps.stateBaseline
  deps.stateBaseline = async (...args) => {
    paused.resolve()
    await resume.promise
    return baseline(...args)
  }
  let competingWrites = 0
  const al = () => {
    const odd = ++competingWrites % 2 === 1
    return move('AL', odd ? 'c' : 'b', odd ? 'b' : 'c', other)
  }
  store.commit = async (...args) => {
    expect(await al()).toMatchObject({ ok: true })
    return commit(...args)
  }
  try {
    const alaska = move('AK', 'd', 'b')
    await paused.promise
    for (let index = 0; index < 8; index++)
      expect(await al()).toMatchObject({ ok: true })
    resume.resolve()
    expect(await alaska).toMatchObject({ ok: true })
    expect(competingWrites).toBe(8)
    expect(await store.getBatch(batchId)).toMatchObject({
      revision: 21,
      stateOrders: {
        AK: ['AK.a', 'AK.d', 'AK.b', 'AK.c', 'AK.e'],
        AL: ['AL.a', 'AL.b', 'AL.c', 'AL.d', 'AL.e'],
      },
    })
  } finally {
    resume.resolve()
    await cleanup()
  }
})
