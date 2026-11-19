import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Plate } from '../lib/catalog/types'
import { firestoreJobsStore } from '../lib/jobs/firestore-store'
import { localJobsEnvironment } from '../lib/jobs/local-scope'
import { enqueueRun } from '../lib/jobs/queue/queue'
import type { JobsDeps } from '../lib/jobs/types'
import { firestorePublishLock } from '../lib/publish/firestore'
import { sharedDraftId } from '../lib/review/draft/draft-id'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import { migrateToSharedDraft } from '../lib/review/migration/migrate'
import { firestoreMigrationFence } from '../lib/review/migration/migration-gate'
import type { ReviewDeps, ReviewStore } from '../lib/review/types'
import { sharedDraftScenarios } from '../tests/review/draft-scenarios'
import { migrationScenarios } from '../tests/review/migrate-scenarios'
import { db } from './setup'

migrationScenarios((env) => firestoreReviewStore(db, env), 30_000)
sharedDraftScenarios((env) => firestoreReviewStore(db, env), 30_000)

const lock = db.doc('locks/publish')
let savedLock: FirebaseFirestore.DocumentData | undefined
beforeEach(async () => {
  savedLock = (await lock.get()).data()
  await lock.delete()
})
afterEach(async () => {
  if (savedLock) await lock.set(savedLock)
  else await lock.delete()
})

const pointer = db.doc('config/catalog')
const plate: Plate = {
  id: 'AK.one',
  state: 'AK',
  slug: 'one',
  displayName: 'one',
  image: '',
  tags: [],
}
const ana = { uid: 'ana', name: 'Ana', role: 'editor' as const }
const migrationActor = { uid: 'migration', name: 'Shared draft migration' }

/** Review deps on a one-plate catalog at v1. */
function catalogDeps(store: ReviewStore): ReviewDeps {
  const find = async (id: string) => (id === plate.id ? plate : null)
  return {
    store,
    baseline: find,
    baselineAtVersion: async (_version, id) => find(id),
    stateBaseline: async (_version, state) => (state === 'AK' ? [plate] : []),
    liveVersion: async () => 1,
    now: () => new Date().toISOString(),
  }
}

/** One environment with an open legacy Batch and an approved release to publish. */
async function environment() {
  const env = `migrate-${randomUUID().slice(0, 8)}`
  const store = firestoreReviewStore(db, env)
  const batchId = `${env}-ana`
  const releaseId = `${env}-release`
  const base = {
    createdBy: 'ana',
    createdByName: 'Ana',
    createdAt: '2026-11-18T10:00:00.000Z',
    baselineVersion: 1,
    approval: null,
    plateIds: [plate.id],
    stateOrders: {},
  }
  expect(
    await store.create(
      { ...base, id: batchId, name: "Ana's Batch", state: 'open', revision: 1 },
      [
        {
          plateId: plate.id,
          fields: { tags: ['ana'] },
          authorId: 'ana',
          updatedAt: '2026-11-18T10:00:00.000Z',
          baseRevision: 'base',
          resultRevision: 'result',
        },
      ]
    )
  ).toBe('ok')
  expect(
    await store.create({
      ...base,
      id: releaseId,
      name: 'Release',
      kind: 'release',
      state: 'approved',
      revision: 2,
    })
  ).toBe('ok')
  return { env, store, batchId, releaseId, draftId: sharedDraftId(env) }
}

/** Call `late` once, the moment the migration starts closing the legacy Batch. */
function onFold(
  store: ReviewStore,
  batchId: string,
  late: () => Promise<void>
) {
  let fired = false
  return new Proxy(store, {
    get(target, key, receiver) {
      if (key !== 'getBatch') return Reflect.get(target, key, receiver)
      return async (id: string) => {
        if (id === batchId && !fired) {
          fired = true
          await late()
        }
        return target.getBatch(id)
      }
    },
  })
}

test('a Publish that tries to start after the migration began waits until the fold is written', async () => {
  const { env, store, batchId, releaseId } = await environment()
  let claimed: boolean | undefined
  const report = await migrateToSharedDraft(
    catalogDeps(
      onFold(store, batchId, async () => {
        const now = new Date().toISOString()
        claimed = await firestorePublishLock(db, env).claim(
          {
            token: 'late-publish',
            batchId: releaseId,
            revision: 2,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          now
        )
      })
    ),
    env,
    {
      apply: true,
      actor: migrationActor,
      fence: firestoreMigrationFence(db, env),
    }
  )
  expect(claimed).toBe(false)
  expect(report).toMatchObject({ applied: true, folded: [batchId] })
  expect((await lock.get()).exists).toBe(false)
})

test('pipeline work queued after the migration began is refused until the fold is written', async () => {
  const { env, store, batchId, draftId } = await environment()
  const scope = env.replace(/[^a-zA-Z0-9_-]/g, '-')
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const jobs: JobsDeps = {
    store: firestoreJobsStore(db, localJobsEnvironment(scope), env),
    localScope: scope,
    baseline: async (id) => (id === plate.id ? plate : null),
    stateBaseline: async () => [plate],
    now: () => Date.now(),
    id: () => randomUUID(),
    leaseMs: 60_000,
  }
  let queued: Awaited<ReturnType<typeof enqueueRun>> | undefined
  try {
    const report = await migrateToSharedDraft(
      catalogDeps(
        onFold(store, batchId, async () => {
          queued = await enqueueRun(jobs, ana, {
            requestId: 'late-run',
            batchId: draftId,
            plateIds: [plate.id],
            stages: ['tag'],
          })
        })
      ),
      env,
      {
        apply: true,
        actor: migrationActor,
        fence: firestoreMigrationFence(db, env),
      }
    )
    expect(queued).toEqual({ ok: false, error: 'publish_in_progress' })
    expect(report).toMatchObject({ applied: true, folded: [batchId] })
    // With the fold written the environment is free again.
    expect(
      await enqueueRun(jobs, ana, {
        requestId: 'after-run',
        batchId: draftId,
        plateIds: [plate.id],
        stages: ['tag'],
      })
    ).toMatchObject({ ok: true })
  } finally {
    vi.unstubAllEnvs()
    const runs = await db
      .collection('localPipelineRuns')
      .where('batchId', '==', draftId)
      .get()
    await Promise.all(runs.docs.map((run) => db.recursiveDelete(run.ref)))
  }
})

test('a catalog pointer that moves during the fold stops the draft write, and a rerun finishes it', async () => {
  const { env, store, batchId, draftId } = await environment()
  const saved = (await pointer.get()).data()
  try {
    await pointer.set({ version: 1 })
    const report = await migrateToSharedDraft(
      catalogDeps(
        onFold(store, batchId, async () => {
          await pointer.set({ version: 2 })
        })
      ),
      env,
      {
        apply: true,
        actor: migrationActor,
        fence: firestoreMigrationFence(db, env),
      }
    )
    expect(report).toMatchObject({ applied: false, refused: 'catalog_moved' })
    expect(await store.getBatch(batchId)).toMatchObject({ state: 'folded' })
    expect((await lock.get()).exists).toBe(false)
    const rerun = await migrateToSharedDraft(catalogDeps(store), env, {
      apply: true,
      actor: migrationActor,
      fence: firestoreMigrationFence(db, env),
    })
    expect(rerun).toMatchObject({ applied: true, folded: [batchId] })
    expect((await store.readBatch(draftId))!.edits).toMatchObject([
      { plateId: plate.id, fields: { tags: ['ana'] } },
    ])
  } finally {
    if (saved) await pointer.set(saved)
    else await pointer.delete()
  }
})

/** Call `late` once, just before the migration writes the fold into the draft. */
function onDraftCommit(
  store: ReviewStore,
  draftId: string,
  late: () => Promise<void>
) {
  let fired = false
  return new Proxy(store, {
    get(target, key, receiver) {
      if (key !== 'commit') return Reflect.get(target, key, receiver)
      return async (...args: Parameters<ReviewStore['commit']>) => {
        if (args[0] === draftId && !fired) {
          fired = true
          await late()
        }
        return target.commit(...args)
      }
    },
  })
}

test('a fold that loses its hold to a Publish after confirming it is not written', async () => {
  const { env, store, batchId, releaseId, draftId } = await environment()
  const saved = (await pointer.get()).data()
  try {
    await pointer.set({ version: 1 })
    let claimed: boolean | undefined
    const report = await migrateToSharedDraft(
      catalogDeps(
        onDraftCommit(store, draftId, async () => {
          // The run stalls past its lease after confirming the hold. A Publish then
          // claims the lock and moves the pointer before the fold lands.
          const later = Date.now() + 11 * 60_000
          claimed = await firestorePublishLock(db, env).claim(
            {
              token: 'late-publish',
              batchId: releaseId,
              revision: 2,
              expiresAt: new Date(later + 60_000).toISOString(),
            },
            new Date(later).toISOString()
          )
          await pointer.set({ version: 2 })
        })
      ),
      env,
      {
        apply: true,
        actor: migrationActor,
        fence: firestoreMigrationFence(db, env),
      }
    )
    expect(claimed).toBe(true)
    expect(report).toMatchObject({
      applied: false,
      refused: 'reservation_lost',
    })
    expect((await store.readBatch(draftId))?.edits ?? []).toEqual([])
    expect(await store.getBatch(batchId)).toMatchObject({ state: 'folded' })
    // Releasing the lost hold leaves the Publish's lock in place.
    expect((await lock.get()).get('token')).toBe('late-publish')
  } finally {
    if (saved) await pointer.set(saved)
    else await pointer.delete()
  }
})

test('the migration waits for any live publish lock, since every environment shares the pointer', async () => {
  const env = `migrate-${randomUUID().slice(0, 8)}`
  const now = Date.parse('2026-11-18T12:00:00Z')
  await lock.set({
    env: 'other-env',
    purpose: 'publish',
    token: 'other',
    expiresAt: '2026-11-18T12:05:00Z',
  })
  expect(await firestoreMigrationFence(db, env, () => now).acquire()).toBe(
    'publish_locked'
  )
  // An expired lock no longer holds the pointer.
  const later = firestoreMigrationFence(db, env, () => now + 10 * 60_000)
  expect(await later.acquire()).toBeNull()
  expect((await lock.get()).data()).toMatchObject({ env, purpose: 'migration' })
  await later.release()
  expect((await lock.get()).exists).toBe(false)
})

test('a second migration waits for a live one, and takes over once an interrupted run has expired', async () => {
  const env = `migrate-${randomUUID().slice(0, 8)}`
  const now = Date.parse('2026-11-18T12:00:00Z')
  const first = firestoreMigrationFence(db, env, () => now)
  expect(await first.acquire()).toBeNull()
  expect(await firestoreMigrationFence(db, env, () => now).acquire()).toBe(
    'migration_running'
  )
  // The first run stopped without releasing; its hold lapses.
  const second = firestoreMigrationFence(db, env, () => now + 11 * 60_000)
  expect(await second.acquire()).toBeNull()
  expect(await first.confirm()).toBe('reservation_lost')
  await first.release()
  expect((await lock.get()).get('purpose')).toBe('migration')
  await second.release()
})

test('the migration waits while a pipeline run on one of its Batches is queued or running', async () => {
  const env = `migrate-${randomUUID().slice(0, 8)}`
  const batchId = `${env}-batch`
  const run = db.doc(`localPipelineRuns/${env}-run`)
  await db.doc(`reviewBatches/${batchId}`).set({ env, state: 'open' })
  await run.set({ batchId, status: 'running' })
  try {
    expect(await firestoreMigrationFence(db, env).acquire()).toBe(
      'pipeline_busy'
    )
    await run.update({ status: 'completed' })
    const fence = firestoreMigrationFence(db, env)
    expect(await fence.acquire()).toBeNull()
    await fence.release()
  } finally {
    await run.delete()
    await db.doc(`reviewBatches/${batchId}`).delete()
  }
})
