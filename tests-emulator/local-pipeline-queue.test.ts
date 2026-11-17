import { Firestore } from '@google-cloud/firestore'
import { lookup } from 'node:dns/promises'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest'
import { firestoreJobsStore } from '../lib/jobs/firestore-store'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import { localJobsEnvironment } from '../lib/jobs/local-scope'
import { cancelRun, enqueueRun, listRuns, retryRun } from '../lib/jobs/queue'
import { bindQueueWorkflow, chooseQueueImage, confirmStoppedWorker, dispatchQueueStage, observeQueueStage } from '../lib/jobs/queue-engine'
import { claimNext, reportResult } from '../lib/jobs/jobs'
import { applyQueueBundle } from '../lib/jobs/queue-bundle'
import type { JobsDeps } from '../lib/jobs/types'
import type { ReviewDeps } from '../lib/review/types'

if (!process.env.FIRESTORE_EMULATOR_HOST) throw Error('Queue emulator tests require a localhost emulator')
const endpoint = new URL(`http://${process.env.FIRESTORE_EMULATOR_HOST}`)
const loopback = await lookup('localhost', { all: true })
if (!endpoint.port || endpoint.hostname !== 'localhost' && !loopback.some(value => value.address === endpoint.hostname.replace(/^\[|\]$/g, ''))) throw Error('Queue emulator tests require a localhost emulator')
const db = new Firestore({ projectId: 'demo-local-pipeline-queue' })
const actor = { uid: 'queue-editor', role: 'editor' as const, name: null }
const plates = ['one', 'two'].map(slug => ({ id: `AK.${slug}`, state: 'AK', slug, displayName: slug, image: '', tags: [] }))
const collections = ['jobs', 'localPipelineRuns', 'reviewBatches']
let time = 100, sequence = 0
let jobs: JobsDeps, review: ReviewDeps

async function clear() { for (const name of collections) await db.recursiveDelete(db.collection(name)) }
beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1'); time = 100; sequence = 0
  await clear()
  const store = firestoreReviewStore(db, 'development')
  await store.create({ id: 'batch', name: 'Queue emulator', createdBy: actor.uid, createdByName: null, createdAt: '', revision: 0, state: 'open',
    baselineVersion: 1, plateIds: plates.map(plate => plate.id), stateOrders: {}, approval: null })
  const baseline = async (id: string) => plates.find(plate => plate.id === id) ?? null
  jobs = { store: firestoreJobsStore(db, localJobsEnvironment('queue-emulator'), 'development'), localScope: 'queue-emulator', baseline,
    stateBaseline: async () => plates, now: () => time, id: () => `claim-${++sequence}`, leaseMs: 1000 }
  review = { store, baseline, baselineAtVersion: async (_version, id) => baseline(id), stateBaseline: async () => plates, now: () => 'today' }
})
afterEach(() => vi.unstubAllEnvs())
afterAll(async () => { await clear(); await db.terminate() })

async function enqueue(requestId = 'request', stages: ('tag' | 'describe')[] = ['tag']) {
  const result = await enqueueRun(jobs, actor, { requestId, batchId: 'batch', plateIds: plates.map(plate => plate.id), stages })
  if (!result.ok) throw Error(result.error)
  await bindQueueWorkflow(jobs, result.value.id, 1, `workflow-${requestId}`)
  await dispatchQueueStage(jobs, result.value.id, 1, 0, `hook-${requestId}`)
  return result.value
}

test('real serialized runs survive store recreation, dedupe, and enforce one GPU claim across processes', async () => {
  const input = { requestId: 'same', batchId: 'batch', plateIds: plates.map(plate => plate.id), stages: ['tag' as const] }
  const results = await Promise.all([enqueueRun(jobs, actor, input), enqueueRun({ ...jobs }, actor, input)])
  expect(results.every(result => result.ok)).toBe(true)
  expect(await jobs.store.transaction(tx => tx.runs())).toHaveLength(1)
  const first = results[0]
  if (!first.ok) throw Error(first.error)
  await bindQueueWorkflow(jobs, first.value.id, 1, 'workflow')
  await dispatchQueueStage(jobs, first.value.id, 1, 0, 'hook')
  time++
  await enqueue('second')
  const restored = { ...jobs, store: firestoreJobsStore(db, localJobsEnvironment('queue-emulator'), 'development') }
  const claims = await Promise.all([claimNext(jobs, 'one'), claimNext(restored, 'two')])
  expect(claims.filter(Boolean)).toHaveLength(1)
  const listed = await listRuns(restored, actor)
  expect(listed).toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining({ id: first.value.id })]) })
  expect(await listRuns(restored, { ...actor, uid: 'other' })).toEqual({ ok: true, value: [] })
  expect(await claimNext({ ...jobs, store: firestoreJobsStore(db, 'development'), localScope: undefined }, 'production')).toBeNull()
}, 20_000)

test('stale worker restart remains reserved until verified stopped recovery; queued cancellation and retry retain history', async () => {
  const run = await enqueue('stale')
  const claim = (await claimNext(jobs, 'dead-worker'))!
  time += 11 * 60_000
  const restored = { ...jobs, store: firestoreJobsStore(db, localJobsEnvironment('queue-emulator'), 'development') }
  await observeQueueStage(restored, run.id, 1, 0)
  await enqueue('waiting')
  expect(await claimNext(restored, 'new-worker')).toBeNull()
  expect(await cancelRun(restored, actor, run.id)).toMatchObject({ value: { status: 'running' } })
  expect(await confirmStoppedWorker(restored, actor, run.id, claim.job.id, claim.claimId)).toMatchObject({ ok: true })
  await observeQueueStage(restored, run.id, 1, 0)
  expect(await retryRun(restored, actor, run.id, 'retry')).toMatchObject({ value: { attempts: [{ number: 1 }, { number: 2 }] } })
  expect(await claimNext(restored, 'new-worker')).not.toBeNull()
})

test('result reconciliation advances dependencies and one atomic bundle Apply preserves source revisions/idempotence', async () => {
  const run = await enqueue('apply', ['describe'])
  for (let index = 0; index < plates.length; index++) {
    if (index) await dispatchQueueStage(jobs, run.id, 1, index, `hook-${index}`)
    const claim = (await claimNext(jobs, 'worker'))!
    const report = { backend: 'fixture', model: 'test', promptVersion: 'v1', durationMs: 10,
      fieldSuggestion: { kind: 'fields', stage: 'describe', fields: { description: `Description ${index}` }, sources: ['https://example.org/source'] } }
    expect(await reportResult(jobs, 'worker', claim.job.id, claim.claimId, report)).toMatchObject({ ok: true })
    await observeQueueStage({ ...jobs }, run.id, 1, index)
  }
  expect(await review.store.listEdits('batch')).toEqual([])
  expect(await applyQueueBundle(jobs, review, actor, run.id)).toMatchObject({ value: { revision: 1 } })
  expect(await review.store.listEdits('batch')).toHaveLength(2)
  expect(await applyQueueBundle(jobs, review, actor, run.id)).toMatchObject({ value: { revision: 1 } })
})

test('serialized specialized image choices and one Group keep original peer hashes and apply one verified bundle', async () => {
  const bytes = Buffer.from('queue emulator verified image')
  const candidate = { id: 'photo', title: 'Photo', imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Plate.jpg',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Plate.jpg', width: 640, height: 320, sha256: createHash('sha256').update(bytes).digest('hex') }
  const result = await enqueueRun(jobs, actor, { requestId: 'specialized', batchId: 'batch', plateIds: plates.map(plate => plate.id), stages: ['find-image', 'group'] })
  if (!result.ok) throw Error(result.error)
  const id = result.value.id
  await bindQueueWorkflow(jobs, id, 1, 'specialized-workflow')
  for (let index = 0; index < 3; index++) {
    await dispatchQueueStage(jobs, id, 1, index, `specialized-hook-${index}`)
    const claim = (await claimNext(jobs, 'worker'))!
    const job = claim.job
    const meta = { backend: 'fixture', model: 'fixture', promptVersion: 'v1', durationMs: 1 }
    if (job.stage === 'find-image') {
      expect(await reportResult(jobs, 'worker', job.id, claim.claimId, { ...meta, fieldSuggestion: { kind: 'image', stage: 'find-image', candidates: [candidate], sources: [candidate.imageUrl, candidate.sourceUrl] } })).toMatchObject({ ok: true })
      expect(await observeQueueStage(jobs, id, 1, index)).toEqual({ phase: 'waiting' })
      expect(await chooseQueueImage(jobs, actor, id, job.id, candidate.id)).toMatchObject({ ok: true })
    } else {
      expect(job.groupScope?.every(member => member.plate.imageUrl === candidate.imageUrl)).toBe(true)
      expect(job.standardId).toBe('AK.one')
      const scope = job.groupScope!.map(member => ({ plateId: member.plate.id, baseRevision: member.baseRevision }))
      expect(await reportResult(jobs, 'worker', job.id, claim.claimId, { ...meta, fieldSuggestion: { kind: 'group', stage: 'group', scope, sources: [],
        proposals: scope.map(member => ({ ...member, fields: { templateFamily: 'AK.one', templateRole: member.plateId === 'AK.one' ? 'template' : 'variant', variantOfPlateId: member.plateId === 'AK.one' ? null : 'AK.one' } })) } })).toMatchObject({ ok: true })
    }
    await observeQueueStage(jobs, id, 1, index)
  }
  expect(await review.store.listEdits('batch')).toEqual([])
  const listed = await listRuns({ ...jobs, store: firestoreJobsStore(db, localJobsEnvironment('queue-emulator'), 'development') }, actor)
  expect(listed).toMatchObject({ ok: true, value: [{ status: 'completed' }] })
  expect(await applyQueueBundle(jobs, review, actor, id, async () => bytes)).toMatchObject({ value: { revision: 1 } })
  expect(await review.store.listEdits('batch')).toHaveLength(2)
  expect(await applyQueueBundle(jobs, review, actor, id, async () => bytes)).toMatchObject({ value: { revision: 1 } })
}, 20_000)
