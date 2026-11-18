import { afterAll, beforeEach, expect, test } from 'vitest'
import type { Firestore, Transaction } from '@google-cloud/firestore'
import {
  firestorePublishPointer,
  firestorePublishRecords,
} from '../lib/publish/firestore'
import { verifyPreparedObject } from '../lib/publish/object'
import { publishBatch } from '../lib/publish/publish'
import { abandonPreparedSnapshot } from '../lib/publish/abandon'
import {
  actor,
  cleanupRelease,
  env,
  now,
  releaseFixture,
  resetRelease,
} from './release-fixture'
import { batch, command, owner } from '../tests/publish/fixture'
import { db } from './setup'

beforeEach(resetRelease)
afterAll(cleanupRelease)

/**
 * Observe Firestore transaction depth and query filters to detect unsafe workflow
 * lookups.
 */
function observedDb() {
  let depth = 0
  const modes: unknown[] = []
  const filters: unknown[][] = []
  const observed = new Proxy(db, {
    /** Intercept the operations under observation while preserving Firestore binding for other calls. */ get(
      target,
      key
    ) {
      if (key === 'runTransaction')
        return (
          run: (tx: Transaction) => Promise<unknown>,
          options?: object
        ) => {
          modes.push(options)
          return db.runTransaction(async (tx) => {
            depth++
            try {
              return await run(tx)
            } finally {
              depth--
            }
          }, options)
        }
      if (key === 'collection')
        return (path: string) =>
          new Proxy(db.collection(path), {
            /** Record query filters as the fixture code builds Firestore collection queries. */ get(
              collection,
              method
            ) {
              if (method === 'where')
                return (...args: Parameters<typeof collection.where>) => {
                  filters.push([path, ...args])
                  return collection.where(...args)
                }
              const value = Reflect.get(collection, method)
              return typeof value === 'function'
                ? value.bind(collection)
                : value
            },
          })
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as Firestore
  return {
    observed,
    modes,
    filters,
    /** Expose current transaction depth so a workflow lookup can record whether it ran inside a transaction. */ depth:
      () => depth,
  }
}

test('retry GET preflight resolves Workflow outside Firestore and uses read-only transactions', async () => {
  const f = releaseFixture()
  await f.deps.records.accept(command, now)
  await f.deps.records.bindRun(command, 'terminal', now)
  const tracked = observedDb()
  const depths: number[] = []
  const records = firestorePublishRecords(tracked.observed, env, {
    /** Provide controlled workflow status for the publish or queue recovery scenario. */ runStatus:
      async () => {
        depths.push(tracked.depth())
        return 'completed'
      },
  })
  expect(
    await records.eligibility({ ...command, commandId: 'fresh' }, now)
  ).toMatchObject({ canRetry: true })
  expect(depths).toEqual([0])
  expect(
    tracked.modes.every(
      (mode) => (mode as { readOnly?: boolean })?.readOnly === true
    )
  ).toBe(true)
})

test('GET fails closed on a changed claim and resolves the new run on the next request', async () => {
  const f = releaseFixture()
  await f.deps.records.accept(command, now)
  await f.deps.records.bindRun(command, 'terminal', now)
  const seen: string[] = []
  const records = firestorePublishRecords(db, env, {
    /** Change the persisted workflow claim during lookup to exercise claim reconciliation. */ runStatus:
      async (runId) => {
        seen.push(runId)
        if (runId === 'terminal') {
          await db.doc('reviewBatches/batch').update({
            publishCommand: { commandId: 'replacement', revision: 2 },
          })
          await db.doc('publishCommands/replacement').set({
            env,
            command: { ...command, commandId: 'replacement' },
            acceptedAt: now,
            runId: 'new-live-run',
          })
          return 'completed'
        }
        return 'running'
      },
  })
  expect(
    await records.eligibility({ ...command, commandId: 'fresh' }, now)
  ).toMatchObject({ canRetry: false, reason: 'locked' })
  expect(
    await records.eligibility({ ...command, commandId: 'fresh' }, now)
  ).toMatchObject({ canRetry: false, reason: 'locked' })
  expect(seen).toEqual(['terminal', 'new-live-run'])
})

test('storage HTTP verification also happens before the Firestore pointer transaction', async () => {
  const f = releaseFixture()
  const tracked = observedDb()
  const depths: number[] = []
  f.deps.pointer = firestorePublishPointer(
    tracked.observed,
    env,
    async (record) => {
      depths.push(tracked.depth())
      return verifyPreparedObject(f.deps.snapshots, record)
    }
  )
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  expect(depths).toEqual([0])
})

test('abandon resolves Workflow outside Firestore and rejects a claim changed during lookup', async () => {
  const f = releaseFixture()
  await f.deps.records.accept(command, now)
  await f.deps.records.bindRun(command, 'terminal', now)
  f.deps.snapshots.createOnly = async () => {
    throw new Error('before upload')
  }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({
    error: 'unavailable',
  })
  const receipt = (await f.deps.records.get('batch@2'))!
  const tracked = observedDb()
  const depths: number[] = []
  const records = firestorePublishRecords(tracked.observed, env, {
    /** Record the lookup's transaction depth and change the active workflow claim once. */ runStatus:
      async () => {
        depths.push(tracked.depth())
        if (tracked.depth() === 0) {
          await db.doc('reviewBatches/batch').update({
            publishCommand: { commandId: 'replacement', revision: 2 },
          })
          await db.doc('publishCommands/replacement').set({
            env,
            command: { ...command, commandId: 'replacement' },
            acceptedAt: now,
            runId: 'new-live-run',
          })
        }
        return 'completed'
      },
  })
  expect(
    await abandonPreparedSnapshot(
      { ...f.deps, records },
      actor,
      receipt,
      'claim raced'
    )
  ).toMatchObject({ error: 'locked' })
  expect(depths.every((depth) => depth === 0)).toBe(true)
  expect((await db.doc('publishVersionBurns/2').get()).exists).toBe(false)
})

test('allocator filters legacy receipts to targets greater than the current pointer', async () => {
  const tracked = observedDb()
  const f = releaseFixture()
  const records = firestorePublishRecords(tracked.observed, env)
  const lease = {
    ...command,
    token: 'allocation',
    expiresAt: '2026-11-15T12:01:00Z',
  }
  await db.doc('publishRecords/legacy-held').set({
    id: 'legacy-held',
    ...command,
    env: 'foreign',
    fromVersion: 1,
    toVersion: 2,
    state: 'started',
    blobSha256: 'held',
  })
  expect(await f.deps.lock.claim(lease, now)).toBe(true)
  expect(await records.nextVersion(lease.token, now)).toBe(3)
  expect(tracked.filters).toContainEqual([
    'publishRecords',
    'toVersion',
    '>',
    1,
  ])
})

test('uncommitted disposition below the live pointer protects any committed target across environments', async () => {
  const f = releaseFixture()
  f.deps.snapshots.createOnly = async () => {
    throw new Error('before upload')
  }
  await publishBatch(f.deps, owner, command)
  const receipt = (await f.deps.records.get('batch@2'))!
  await f.deps.control.change(true, actor, now)
  await f.deps.control.check(command, now)
  await db.doc('config/catalog').set({ version: 5 })
  expect(
    await abandonPreparedSnapshot(f.deps, actor, receipt, 'past head')
  ).toMatchObject({ ok: true })
  expect((await f.deps.pointer.read()).version).toBe(5)
  await db
    .doc('reviewBatches/foreign-target')
    .set({ ...batch, id: 'foreign-target', env })
  const foreign = {
    ...receipt,
    id: 'foreign-target@2',
    batchId: 'foreign-target',
    toVersion: 4,
  }
  await db.doc('publishRecords/foreign-target@2').set({ ...foreign, env })
  await db.doc('publishRecords/other-committed').set({
    ...foreign,
    id: 'other-committed',
    env: 'another-environment',
    committedAt: now,
  })
  expect(
    await abandonPreparedSnapshot(f.deps, actor, foreign, 'must refuse')
  ).toMatchObject({ error: 'version_taken' })
})
