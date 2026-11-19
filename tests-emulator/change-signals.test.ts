import { afterAll, beforeEach, expect, test } from 'vitest'
import { Firestore } from '@google-cloud/firestore'
import { signalChange } from '../lib/live/change-signals'
import { topicSignalId, type ChangeTopic } from '../lib/live/topics'
import { liveEnvKey, signalPath } from '../lib/review/live-signal'
import { firestoreJobsStore } from '../lib/jobs/firestore-store'
import type { LocalWorkerCapabilities } from '../lib/jobs/capabilities'
import type { TaggingJob } from '../lib/jobs/types'
import { firestoreResearchStore } from '../lib/research/firestore-store'
import type { ResearchJob } from '../lib/research/types'
import { firestorePublishLock } from '../lib/publish/firestore'
import './setup'

const db = new Firestore({ projectId: 'demo-plate-curator-signals' })
const env = 'preview:signals'

/** Read the current revision of a change topic, treating a missing doc as zero. */
async function revision(topic: ChangeTopic) {
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
  await signalChange(db, env, 'pipeline')
  expect(await revision('pipeline')).toBe(1)

  // One write in flight plus one queued, however many changes arrive meanwhile.
  await Promise.all(
    Array.from({ length: 10 }, () => signalChange(db, env, 'pipeline'))
  )
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
