import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { Firestore } from '@google-cloud/firestore'
import { settleSignals, signalChange } from '../lib/live/change-signals'
import { topicSignalId, type ChangeTopic } from '../lib/live/topics'
import { liveEnvKey, signalPath } from '../lib/review/signals/live-signal'
import { firestoreJobsStore } from '../lib/jobs/firestore-store'
import type { LocalWorkerCapabilities } from '../lib/jobs/capabilities'
import type { TaggingJob } from '../lib/jobs/types'
import { firestoreResearchStore } from '../lib/research/stores/firestore-store'
import type { ResearchJob } from '../lib/research/types'
import { firestorePublishLock } from '../lib/publish/firestore'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import type { ReviewBatch } from '../lib/review/types'
import './setup'

const db = new Firestore({ projectId: 'demo-plate-curator-signals' })
const env = 'preview:signals'

/** Read a change topic's revision once its signals settle; a missing doc is zero. */
async function revision(topic: ChangeTopic) {
  await settleSignals()
  const snapshot = await db
    .doc(signalPath(liveEnvKey(env), topicSignalId(topic)))
    .get()
  return (snapshot.get('revision') as number | undefined) ?? 0
}

const capabilities: LocalWorkerCapabilities = {
  group: { available: true },
  embeddings: { available: true },
  mask: { available: true },
  vision: { available: false, reason: 'No local vision service' },
  pollIntervalMs: 5000,
}

function job(id: string): TaggingJob {
  return {
    id,
    batchId: 'batch',
    plateId: 'one',
    requestedBy: 'editor',
    inputHash: 'input',
    env,
    createdAt: 0,
    state: 'queued',
  }
}

beforeEach(async () => {
  await Promise.all(
    [
      'curatorLive',
      'jobs',
      'localPipelineCapabilities',
      'researchJobs',
      'locks',
      'reviewBatches',
    ].map((name) => db.recursiveDelete(db.collection(name)))
  )
})

afterAll(async () => {
  await db.terminate()
})

test('topic signals live beside batch signals so the existing grant rule covers them', () => {
  expect(signalPath(liveEnvKey(env), topicSignalId('pipeline'))).toBe(
    'curatorLive/preview%3Asignals/batchRevisions/topic:pipeline'
  )
})

test('each change bumps the topic revision, and a burst coalesces to two writes', async () => {
  signalChange(db, env, 'pipeline')
  expect(await revision('pipeline')).toBe(1)

  // One write in flight plus one queued, however many changes arrive meanwhile.
  for (let index = 0; index < 10; index++) signalChange(db, env, 'pipeline')
  expect(await revision('pipeline')).toBe(3)
  expect(await revision('research')).toBe(0)
})

test('a jobs transaction that writes signals pipeline listeners; a read-only one does not', async () => {
  const store = firestoreJobsStore(db, env)
  await store.transaction(async (tx) => tx.get('missing'))
  expect(await revision('pipeline')).toBe(0)

  await store.transaction(async (tx) => tx.create(job('signal-job')))
  expect(await revision('pipeline')).toBe(1)
  expect(await revision('gateway')).toBe(0)
  expect((await db.doc('jobs/signal-job').get()).exists).toBe(true)
})

test('a hosted job write also signals Gateway listeners, which local work leaves alone', async () => {
  const store = firestoreJobsStore(db, env)
  await store.transaction(async (tx) =>
    tx.create({ ...job('hosted-job'), route: 'hosted' })
  )
  expect(await revision('gateway')).toBe(1)
  expect(await revision('pipeline')).toBe(1)

  await store.transaction(async (tx) =>
    tx.set({ ...job('local-job'), route: 'local' })
  )
  expect(await revision('gateway')).toBe(1)
  expect(await revision('pipeline')).toBe(2)
})

test('a worker heartbeat signals only when the dashboard would show a change', async () => {
  const store = firestoreJobsStore(db, env)
  const record = { workerId: 'desk', reportedAt: 1000, capabilities }
  await store.writeCapabilities('scope', record)
  expect(await revision('pipeline')).toBe(1)

  // A routine refresh one poll later is stored but changes nothing visible.
  await store.writeCapabilities('scope', { ...record, reportedAt: 6000 })
  expect((await store.readCapabilities('scope'))?.reportedAt).toBe(6000)
  expect(await revision('pipeline')).toBe(1)

  // Different availability is visible.
  await store.writeCapabilities('scope', {
    ...record,
    reportedAt: 7000,
    capabilities: {
      ...capabilities,
      mask: { available: false, reason: 'off' },
    },
  })
  expect(await revision('pipeline')).toBe(2)

  // So is a worker reporting again after it went stale (more than two polls).
  await store.writeCapabilities('scope', {
    ...record,
    reportedAt: 30_000,
    capabilities: {
      ...capabilities,
      mask: { available: false, reason: 'off' },
    },
  })
  expect(await revision('pipeline')).toBe(3)
})

test('a research job write signals research listeners', async () => {
  const store = firestoreResearchStore(db, env)
  await store.transaction(async (tx) => tx.get('missing'))
  expect(await revision('research')).toBe(0)

  await store.transaction(async (tx) =>
    tx.set({ id: 'research-job', env, state: 'queued' } as ResearchJob)
  )
  expect(await revision('research')).toBe(1)
  expect(await revision('pipeline')).toBe(0)
})

test('claiming and releasing the publish lock signal publish listeners; a refused claim does not', async () => {
  const lock = firestorePublishLock(db, env)
  await db
    .doc('reviewBatches/signal-batch')
    .set({ env, state: 'open', revision: 1 })
  const lease = {
    token: 'first',
    batchId: 'signal-batch',
    revision: 1,
    expiresAt: '2026-11-15T12:01:00Z',
    purpose: 'abandon' as const,
  }
  const now = '2026-11-15T12:00:00Z'
  expect(await lock.claim(lease, now)).toBe(true)
  expect(await revision('publish')).toBe(1)

  expect(await lock.claim({ ...lease, token: 'second' }, now)).toBe(false)
  expect(await revision('publish')).toBe(1)

  await lock.release('second', false)
  expect(await revision('publish')).toBe(1)
  await lock.release('first', false)
  expect(await revision('publish')).toBe(2)
})

/**
 * The same database, except that every topic signal write runs `write` instead, so a
 * test can hold one open or refuse it.
 */
function withTopicWrites(write: () => Promise<unknown>): Firestore {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'doc')
        return (path: string) =>
          path.includes('/batchRevisions/topic:')
            ? { set: write }
            : target.doc(path)
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Fail if `promise` is still waiting after `ms`, as it would on a held topic write. */
function promptly<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('still waiting on a topic write')), ms)
    ),
  ])
}

for (const mode of ['held', 'refused'] as const)
  test(`a ${mode} topic write never holds up the job, heartbeat, research or publish lock commit`, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // One gate holds every topic write, including follow-ups queued behind the first.
    let release!: () => void
    const held = new Promise((resolve) => (release = () => resolve(undefined)))
    const topicDb = withTopicWrites(() =>
      mode === 'held' ? held : Promise.reject(new Error('topic write refused'))
    )
    try {
      const jobs = firestoreJobsStore(topicDb, env)
      await promptly(jobs.transaction(async (tx) => tx.create(job('held-job'))))
      expect((await db.doc('jobs/held-job').get()).exists).toBe(true)
      await promptly(
        jobs.writeCapabilities('scope', {
          workerId: 'desk',
          reportedAt: 1000,
          capabilities,
        })
      )

      await promptly(
        firestoreResearchStore(topicDb, env).transaction(async (tx) =>
          tx.set({ id: 'held-research', env, state: 'queued' } as ResearchJob)
        )
      )

      const lock = firestorePublishLock(topicDb, env)
      await db
        .doc('reviewBatches/held-batch')
        .set({ env, state: 'open', revision: 1 })
      const now = '2026-11-15T12:00:00Z'
      expect(
        await promptly(
          lock.claim(
            {
              token: 'held',
              batchId: 'held-batch',
              revision: 1,
              expiresAt: '2026-11-15T12:01:00Z',
              purpose: 'abandon',
            },
            now
          )
        )
      ).toBe(true)
      await promptly(lock.release('held', false))
      expect((await db.doc('locks/publish').get()).exists).toBe(false)
    } finally {
      release()
      await settleSignals()
      vi.restoreAllMocks()
    }
  })

test('draft state topics follow committed edits, removed orders and scoped pipeline writes', async () => {
  const store = firestoreReviewStore(db, env)
  const batch: ReviewBatch = {
    id: 'shared-draft-signals',
    kind: 'shared-draft',
    name: 'Shared draft',
    revision: 0,
    baselineVersion: 1,
    plateIds: [],
    stateOrders: { AK: ['AK.one'] },
    state: 'open',
    createdAt: '',
    createdBy: 'owner',
    createdByName: null,
    approval: null,
  }
  const edit = {
    plateId: 'AL.one',
    baseRevision: 'before',
    resultRevision: 'after',
    updatedAt: '',
    authorId: 'editor',
    fields: { tags: ['saved'] },
  }
  const topic = (state: string) => `draft:${state}` as ChangeTopic
  await store.create(batch)
  const edited = { ...batch, revision: 1, plateIds: [edit.plateId] }
  expect(await store.commit(batch.id, 0, { batch: edited, edit })).toBe('ok')
  expect(await revision(topic('AL'))).toBe(1)
  expect(await revision(topic('AK'))).toBe(0)
  expect(await store.commit(batch.id, 0, { batch: edited, edit })).toBe(
    'revision_mismatch'
  )
  expect(await revision(topic('AL'))).toBe(1)

  const jobs = firestoreJobsStore(db, env)
  const applied = {
    batch: { ...edited, revision: 2, plateIds: ['AL.one', 'AL.two'] },
    edit: { ...edit, plateId: 'AL.two' },
  }
  await expect(
    jobs.transaction(async (tx) => {
      expect(await tx.commitDraft(batch.id, 1, applied)).toBe('ok')
      throw new Error('rolled back')
    })
  ).rejects.toThrow('rolled back')
  expect(await revision(topic('AL'))).toBe(1)
  expect(
    await jobs.transaction((tx) => tx.commitDraft(batch.id, 1, applied))
  ).toBe('ok')
  expect(await revision(topic('AL'))).toBe(2)
  expect(await revision(topic('AK'))).toBe(0)
  expect((await store.readBatch(batch.id, new Set(['AK'])))?.edits).toEqual([])

  expect(
    await store.commit(batch.id, 2, {
      batch: {
        ...applied.batch,
        revision: 3,
        baselineVersion: 2,
        stateOrders: {},
        plateIds: [],
      },
      deleteEditsFor: ['AL.one', 'AL.two'],
      history: false,
    })
  ).toBe('ok')
  expect(await revision(topic('AK'))).toBe(1)
  expect(await revision(topic('AL'))).toBe(3)
  expect(await revision(topic('CA'))).toBe(0)
})
