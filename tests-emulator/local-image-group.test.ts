import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { Firestore } from '@google-cloud/firestore'
import { firestoreJobsStore } from '../lib/jobs/firestore-store'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import { createJob, claimNext, reportResult } from '../lib/jobs/jobs'
import {
  readLocalWorkerCapabilities,
  reportLocalWorkerCapabilities,
} from '../lib/jobs/capabilities'
import { acceptGroup } from '../lib/review/group'
import { groupProposal } from '../worker/image-group'
import { plateRevision } from '../lib/review/revision'
import type { JobsDeps } from '../lib/jobs/types'
import type { ReviewDeps } from '../lib/review/types'
import './setup'

const db = new Firestore({ projectId: 'demo-local-image-group' })

/** Clear job, review and capability documents so each grouping scenario starts clean. */
async function clear() {
  for (const name of ['jobs', 'reviewBatches', 'localPipelineCapabilities'])
    await db.recursiveDelete(db.collection(name))
}

beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  await clear()
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await clear()
  await db.terminate()
})

test('capability reports persist per scope with server freshness', async () => {
  let now = 1000
  const d: JobsDeps = {
    store: firestoreJobsStore(db, 'development'),
    /** Simulate an absent plate in the catalog baseline for this case. */ baseline:
      async () => null,
    /** Read the controlled test clock so state and lease timestamps advance deterministically. */ now: () =>
      now,
    /** Supply a deterministic ID so the test can identify the generated record. */ id: () =>
      'claim',
    leaseMs: 1000,
    localScope: 'scope',
  }
  const capabilities = {
    group: { available: true },
    embeddings: { available: true },
    mask: { available: true },
    vision: { available: false, reason: 'Offline' },
    pollIntervalMs: 5000,
  }
  await reportLocalWorkerCapabilities(d, 'worker', capabilities)
  const ref = db
    .collection('localPipelineCapabilities')
    .doc('development--scope')
  const initial = await ref.get()
  now = 5999
  await reportLocalWorkerCapabilities(d, 'worker', capabilities)
  expect((await ref.get()).updateTime?.isEqual(initial.updateTime!)).toBe(true)
  now = 6000
  await reportLocalWorkerCapabilities(d, 'worker', capabilities)
  expect((await ref.get()).updateTime?.isEqual(initial.updateTime!)).toBe(false)
  expect((await readLocalWorkerCapabilities(d)).group.available).toBe(true)
  expect(
    (await readLocalWorkerCapabilities({ ...d, localScope: 'other' })).group
      .reason
  ).toBe('Local worker not reporting')
  now = 16001
  expect((await readLocalWorkerCapabilities(d)).group.available).toBe(false)
})

test('server-rebuilt Group scope and job-bound acceptance round-trip atomically', async () => {
  const actor = { uid: 'editor', name: null, role: 'editor' as const }
  const plates = ['a', 'b'].map((id) => ({
    id: `AK.${id}`,
    state: 'AK',
    slug: id,
    displayName: id,
    image: `${id}.webp`,
    tags: [],
    templateFamily: `old-${id}`,
    templateRole: 'template' as const,
    isStandard: id === 'a',
  }))
  const review = firestoreReviewStore(db, 'development')
  await review.create({
    id: 'batch',
    name: 'Group',
    createdBy: actor.uid,
    createdByName: null,
    createdAt: '',
    state: 'open',
    revision: 0,
    baselineVersion: 1,
    approval: null,
    plateIds: plates.map((plate) => plate.id),
    stateOrders: { AK: plates.map((plate) => plate.id) },
  })
  const d: ReviewDeps = {
    store: review,
    /** Resolve the plate by ID from the fixture baseline. */ baseline: async (
      id
    ) => plates.find((plate) => plate.id === id) ?? null,
    /** Resolve the plate by ID from the fixture baseline. */ baselineAtVersion:
      async (_, id) => plates.find((plate) => plate.id === id) ?? null,
    /** Return the fixture state order used by the review or queue operation. */ stateBaseline:
      async () => plates,
    /** Use an empty timestamp where the scenario does not depend on dates. */ now: () =>
      '',
  }
  const jobs: JobsDeps = {
    store: firestoreJobsStore(db, 'development'),
    baseline: d.baseline,
    baselineAtVersion: d.baselineAtVersion,
    stateBaseline: d.stateBaseline,
    /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () =>
      1000,
    /** Supply a deterministic ID so the test can identify the generated record. */ id: () =>
      'claim',
    leaseMs: 10000,
    localScope: 'scope',
  }
  const groupScope = plates.map((plate) => ({
    plate: { ...plate, displayName: 'Forged' },
    baseRevision: plateRevision(plate),
  }))
  const created = await createJob(jobs, {
    id: 'group',
    batchId: 'batch',
    plateId: plates[0].id,
    requestedBy: actor.uid,
    stage: 'group',
    groupScope,
  })
  expect(created.ok).toBe(true)
  const claimed = await claimNext(jobs, 'worker')
  if (!claimed) throw Error('Missing claim')
  expect(claimed.job.groupScope?.[0].plate.displayName).toBe('a')
  const suggestion = groupProposal(
    claimed.job.groupScope!,
    {
      model: 'fixture',
      groups: [{ templateId: 'AK.b', variants: [{ id: 'AK.a' }] }],
      similarities: [],
    },
    claimed.job.standardId
  )!
  expect(
    await reportResult(jobs, 'worker', 'group', claimed.claimId, {
      fieldSuggestion: suggestion,
      backend: 'fixture',
      model: 'fixture',
      promptVersion: 'fixture',
      durationMs: 0,
    })
  ).toMatchObject({ ok: true })
  expect(await review.listEdits('batch')).toEqual([])
  expect(
    await acceptGroup(d, jobs, actor, {
      batchId: 'batch',
      jobId: 'group',
      batchRevision: 0,
    })
  ).toMatchObject({ ok: true, value: { revision: 1 } })
  expect(await review.listEdits('batch')).toHaveLength(2)
})
