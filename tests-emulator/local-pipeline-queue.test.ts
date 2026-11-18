import { Firestore } from '@google-cloud/firestore'
import { lookup } from 'node:dns/promises'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest'
import { firestoreMembersStore } from '../lib/members/firestore-store'
import { firestoreJobsStore } from '../lib/jobs/firestore-store'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import { localJobsEnvironment } from '../lib/jobs/local-scope'
import { cancelRun, enqueueRun, enqueueSelection, listRuns, retryRun } from '../lib/jobs/queue'
import { bindQueueWorkflow, chooseQueueImage, confirmStoppedWorker, dispatchQueueStage, observeQueueStage, recordQueueWorkflowFailure } from '../lib/jobs/queue-engine'
import { claimNext, reportResult } from '../lib/jobs/jobs'
import { proposeEdit, revertPipelineField } from '../lib/review/batch'
import { plateRevision } from '../lib/review/revision'
import { applyQueueBundle } from '../lib/jobs/queue-bundle'
import type { JobsDeps } from '../lib/jobs/types'
import type { ReviewDeps } from '../lib/review/types'

if (!process.env.FIRESTORE_EMULATOR_HOST) throw Error('Queue emulator tests require a localhost emulator')
const endpoint = new URL(`http://${process.env.FIRESTORE_EMULATOR_HOST}`)
const loopback = await lookup('localhost', { all: true })
if (!endpoint.port || endpoint.hostname !== 'localhost' && !loopback.some(value => value.address === endpoint.hostname.replace(/^\[|\]$/g, ''))) throw Error('Queue emulator tests require a localhost emulator')
const db = new Firestore({ projectId: 'demo-local-pipeline-queue' })
const actor = { uid: 'queue-editor', role: 'editor' as const, name: 'Queue Editor' }
const plates = ['one', 'two'].map(slug => ({ id: `AK.${slug}`, state: 'AK', slug, displayName: slug, image: '', tags: [], description: null }))
const collections = ['jobs', 'localPipelineRuns', 'reviewBatches', 'members']
const editorEmail = 'queue-editor@example.org'
const members = firestoreMembersStore(db)
let time = 100, sequence = 0
let jobs: JobsDeps, review: ReviewDeps

async function clear() { for (const name of collections) await db.recursiveDelete(db.collection(name)) }
beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1'); time = 100; sequence = 0
  await clear()
  await members.upsertSeed({ email: editorEmail, uid: actor.uid, role: actor.role, signIn: 'password', status: 'active',
    invite: null, invitedBy: null, createdAt: '2026-11-17' })
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

test('a missing source skips that plate and shared grouping while other plate results remain applicable', async () => {
  const created = await enqueueRun(jobs, actor, {
    requestId: 'partial-group', batchId: 'batch', plateIds: plates.map(plate => plate.id), stages: ['wiki-link', 'describe', 'group'],
  })
  if (!created.ok) throw Error(created.error)
  const { id } = created.value
  const meta = { backend: 'fixture', model: 'test', promptVersion: 'v1', durationMs: 10 }
  await dispatchQueueStage(jobs, id, 1, 0, 'missing-link')
  const missing = (await claimNext(jobs, 'worker'))!
  expect(await reportResult(jobs, 'worker', missing.job.id, missing.claimId, { ...meta, stageError: 'no_sources' })).toMatchObject({ ok: true })

  const restored = { ...jobs, store: firestoreJobsStore(db, localJobsEnvironment('queue-emulator'), 'development') }
  expect(await observeQueueStage(restored, id, 1, 0)).toEqual({ phase: 'next', nextIndex: 2 })
  expect(await dispatchQueueStage(restored, id, 1, 1, 'skipped-description')).toBeNull()
  const url = 'https://example.org/wiki'
  for (const [index, result] of [
    { kind: 'fields', stage: 'wiki-link', fields: { wikiUrl: url }, sources: [url] },
    { kind: 'fields', stage: 'describe', fields: { description: 'Plate two description' }, sources: [url] },
  ].entries()) {
    await dispatchQueueStage(restored, id, 1, index + 2, `link-stage-${index}`)
    const claim = (await claimNext(restored, 'worker'))!
    expect(claim.job.plateId).toBe(plates[1].id)
    expect(await reportResult(restored, 'worker', claim.job.id, claim.claimId, { ...meta, fieldSuggestion: result })).toMatchObject({ ok: true })
    await observeQueueStage(restored, id, 1, index + 2)
  }
  expect(await dispatchQueueStage(restored, id, 1, 4, 'skipped-group')).toBeNull()
  expect(await claimNext(restored, 'worker')).toBeNull()
  expect(await listRuns(restored, actor)).toMatchObject({ value: [{ status: 'completed', attempts: [{ outcome: 'partial', steps: [
    { status: 'failed' }, { stage: 'describe', status: 'skipped', reason: 'upstream_failed' }, { status: 'completed' }, { status: 'completed' },
    { stage: 'group', status: 'skipped', reason: 'group_member_failed' },
  ] }] }] })
  expect(await applyQueueBundle(restored, review, actor, id)).toMatchObject({ value: { revision: 1 } })
  expect(await review.store.listEdits('batch')).toMatchObject([{ plateId: plates[1].id, fields: { wikiUrl: url, description: 'Plate two description' } }])
}, 20_000)

test('an image choice saves a verified image before Group runs against the updated peers', async () => {
  const bytes = Buffer.from('queue emulator verified image')
  const candidate = { id: 'photo', title: 'Photo', imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Plate.jpg',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Plate.jpg', width: 640, height: 320, sha256: createHash('sha256').update(bytes).digest('hex') }
  const result = await enqueueSelection(jobs, actor, { requestId: 'specialized', batchId: 'batch', plateIds: plates.map(plate => plate.id), stages: ['find-image', 'group'] })
  if (!result.ok) throw Error(result.error)
  const id = result.value[0].id
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
    await observeQueueStage(jobs, id, 1, index, async () => bytes)
    if (index === 0) expect(await review.store.getEdit('batch', plates[0].id)).toMatchObject({ fields: { imageUrl: candidate.imageUrl } })
  }
  const listed = await listRuns({ ...jobs, store: firestoreJobsStore(db, localJobsEnvironment('queue-emulator'), 'development') }, actor)
  expect(listed).toMatchObject({ ok: true, value: [{ status: 'completed' }] })
  expect(await review.store.listEdits('batch')).toMatchObject([
    { fields: { imageUrl: candidate.imageUrl, templateRole: 'template' } },
    { fields: { imageUrl: candidate.imageUrl, templateRole: 'variant' } },
  ])
}, 20_000)

test('model-free Wiki enqueue, dispatch and claim omit modelId in Firestore when no desktop model is enabled', async () => {
  vi.stubEnv('TAGGING_MODELS', 'gateway-gemma4-26b')
  const result = await enqueueRun(jobs, actor, { requestId: 'model-free', batchId: 'batch', plateIds: [plates[0].id], stages: ['wiki-link'] })
  if (!result.ok) throw Error(result.error)
  const id = await dispatchQueueStage(jobs, result.value.id, 1, 0, 'model-free-hook')
  const run = (await jobs.store.transaction(tx => tx.runs()))[0]
  expect(run).not.toHaveProperty('modelId')
  expect(await jobs.store.transaction(tx => tx.get(id!))).not.toHaveProperty('modelId')
  const claim = await claimNext(jobs, 'model-free-worker')
  expect(claim?.job).toMatchObject({ id, state: 'claimed', stage: 'wiki-link' })
  expect(claim?.job).not.toHaveProperty('modelId')
  expect(await jobs.store.transaction(tx => tx.get(id!))).not.toHaveProperty('modelId')
})

test('workflow durably saves each eligible result and preserves it after a later failure or duplicate delivery', async () => {
  const result = await enqueueSelection(jobs, actor, { requestId: 'incremental-durable', batchId: 'batch', plateIds: plates.map(plate => plate.id), stages: ['describe'] })
  if (!result.ok) throw Error(result.error)
  const [run] = result.value
  await bindQueueWorkflow(jobs, run.id, 1, 'incremental-workflow')
  await dispatchQueueStage(jobs, run.id, 1, 0, 'first-hook')
  const claim = (await claimNext(jobs, 'worker'))!
  const completed = { backend: 'fixture', model: 'test', promptVersion: 'v1', durationMs: 10,
    fieldSuggestion: { kind: 'fields', stage: 'describe', fields: { description: 'First saved result' }, sources: ['https://example.org/source'] } }
  expect(await reportResult(jobs, 'worker', claim.job.id, claim.claimId, completed)).toMatchObject({ ok: true })
  const restored = { ...jobs, store: firestoreJobsStore(db, localJobsEnvironment('queue-emulator'), 'development') }
  await observeQueueStage(restored, run.id, 1, 0)
  const afterFirstStage = await review.store.readBatch('batch')
  expect(afterFirstStage).toMatchObject({ batch: { revision: 1 }, edits: [{
    plateId: claim.job.plateId, fields: { description: 'First saved result' },
    pipelineChanges: { description: { runId: run.id, jobId: claim.job.id, by: actor.uid, byName: actor.name, value: 'First saved result' } },
  }] })
  expect(await reportResult(restored, 'worker', claim.job.id, claim.claimId, completed)).toMatchObject({ ok: true })
  await observeQueueStage(restored, run.id, 1, 0)
  await dispatchQueueStage(restored, run.id, 1, 1, 'second-hook')
  const second = (await claimNext(restored, 'worker'))!
  expect(await reportResult(restored, 'worker', second.job.id, second.claimId, { ...completed, fieldSuggestion: undefined, stageError: 'unavailable' })).toMatchObject({ ok: true })
  await observeQueueStage(restored, run.id, 1, 1)
  expect(await listRuns(restored, actor)).toMatchObject({ value: [{ status: 'failed' }] })
  expect(await review.store.readBatch('batch')).toEqual(afterFirstStage)
}, 20_000)

test('a worker result conflicts with a concurrent same-field edit and the newer draft remains intact', async () => {
  const result = await enqueueSelection(jobs, actor, { requestId: 'incremental-conflict', batchId: 'batch', plateIds: [plates[0].id], stages: ['colors'] })
  if (!result.ok) throw Error(result.error)
  const [run] = result.value
  await dispatchQueueStage(jobs, run.id, 1, 0, 'conflict-hook')
  const claim = (await claimNext(jobs, 'worker'))!
  expect(await proposeEdit(review, actor, { batchId: 'batch', plateId: plates[0].id, baseRevision: plateRevision(plates[0]),
    fields: { colorDetail: 'Manual color', tags: ['manual'] } })).toMatchObject({ ok: true })
  expect(await reportResult(jobs, 'worker', claim.job.id, claim.claimId, {
    backend: 'fixture', model: 'test', promptVersion: 'v1', durationMs: 10,
    fieldSuggestion: { kind: 'fields', stage: 'colors', fields: { colorDetail: 'Stale pipeline color', lineageColor: 'Accepted lineage' }, sources: ['https://example.org/source'] },
  })).toMatchObject({ ok: true })
  await observeQueueStage(jobs, run.id, 1, 0)
  expect(await listRuns(jobs, actor)).toMatchObject({ value: [{ status: 'failed', attempts: [{ error: 'draft_conflict' }] }] })
  expect(await review.store.readBatch('batch')).toMatchObject({ batch: { revision: 2 }, edits: [{ fields: { colorDetail: 'Manual color', lineageColor: 'Accepted lineage', tags: ['manual'] } }] })
}, 20_000)

test('cancellation after worker completion preserves the completed result before the run settles', async () => {
  const result = await enqueueSelection(jobs, actor, { requestId: 'incremental-cancel', batchId: 'batch', plateIds: plates.map(plate => plate.id), stages: ['tag'] })
  if (!result.ok) throw Error(result.error)
  const [run] = result.value
  await dispatchQueueStage(jobs, run.id, 1, 0, 'cancel-hook')
  const claim = (await claimNext(jobs, 'worker'))!
  expect(await reportResult(jobs, 'worker', claim.job.id, claim.claimId, {
    backend: 'fixture', model: 'test', promptVersion: 'v1', durationMs: 1, suggestions: ['saved'],
  })).toMatchObject({ ok: true })
  expect(await cancelRun(jobs, actor, run.id)).toMatchObject({ value: { status: 'running' } })
  await observeQueueStage(jobs, run.id, 1, 0)
  expect(await listRuns(jobs, actor)).toMatchObject({ value: [{ status: 'cancelled' }] })
  expect(await review.store.readBatch('batch')).toMatchObject({ batch: { revision: 1 }, edits: [{ fields: { tags: ['saved'] } }] })
}, 20_000)

test('workflow failure reconciliation saves a completed result with its previous draft value', async () => {
  expect(await proposeEdit(review, actor, { batchId: 'batch', plateId: plates[0].id, baseRevision: plateRevision(plates[0]),
    fields: { description: 'Earlier draft', tags: ['manual'] } })).toMatchObject({ ok: true })
  const result = await enqueueSelection(jobs, actor, { requestId: 'incremental-recovery', batchId: 'batch', plateIds: plates.map(plate => plate.id), stages: ['describe'] })
  if (!result.ok) throw Error(result.error)
  const [run] = result.value
  await bindQueueWorkflow(jobs, run.id, 1, 'recovery-workflow')
  await dispatchQueueStage(jobs, run.id, 1, 0, 'recovery-hook')
  const claim = (await claimNext(jobs, 'worker'))!
  expect(await reportResult(jobs, 'worker', claim.job.id, claim.claimId, {
    backend: 'fixture', model: 'test', promptVersion: 'v1', durationMs: 10,
    fieldSuggestion: { kind: 'fields', stage: 'describe', fields: { description: 'Recovered pipeline text' }, sources: ['https://example.org/source'] },
  })).toMatchObject({ ok: true })
  expect(await recordQueueWorkflowFailure(jobs, run.id, 1, 'recovery-workflow', 'failed')).toBe(true)
  expect(await listRuns(jobs, actor)).toMatchObject({ value: [{ status: 'failed', draftPlateIds: [plates[0].id], attempts: [{ error: 'workflow_failed' }] }] })
  expect(await review.store.readBatch('batch')).toMatchObject({ batch: { revision: 2 }, edits: [{
    fields: { description: 'Recovered pipeline text', tags: ['manual'] },
    pipelineChanges: { description: { runId: run.id, previous: 'Earlier draft', value: 'Recovered pipeline text' } },
  }] })
}, 20_000)

test('Preview only and a requester whose draft authority was removed each leave the Batch unchanged', async () => {
  for (const previewOnly of [true, false]) {
    const result = await enqueueSelection(jobs, actor, { requestId: previewOnly ? 'inspect-only' : 'removed-editor', batchId: 'batch', plateIds: [plates[0].id], stages: ['tag'], previewOnly })
    if (!result.ok) throw Error(result.error)
    const [run] = result.value
    await dispatchQueueStage(jobs, run.id, 1, 0, 'isolated-hook')
    const claim = (await claimNext(jobs, 'worker'))!
    expect(await reportResult(jobs, 'worker', claim.job.id, claim.claimId, {
      backend: 'fixture', model: 'test', promptVersion: 'v1', durationMs: 1, suggestions: ['proposed'],
    })).toMatchObject({ ok: true })
    if (!previewOnly) expect(await members.remove(editorEmail)).toBe('ok')
    await observeQueueStage(jobs, run.id, 1, 0)
    const listed = await listRuns(jobs, actor)
    if (!listed.ok) throw Error(listed.error)
    expect(listed.value.find(value => value.id === run.id)).toMatchObject({ status: previewOnly ? 'completed' : 'failed' })
    expect(await review.store.readBatch('batch')).toMatchObject({ batch: { revision: 0 }, edits: [] })
  }
}, 20_000)

test('returning a plate to its baseline keeps prior pipeline attribution without a net draft change', async () => {
  const saved: { runId: string; jobId: string }[] = []
  for (const description of ['Pipeline A', null]) {
    const result = await enqueueSelection(jobs, actor, { requestId: `attribution-${saved.length}`, batchId: 'batch', plateIds: [plates[0].id], stages: ['describe'] })
    if (!result.ok) throw Error(result.error)
    const [run] = result.value
    await dispatchQueueStage(jobs, run.id, 1, 0, 'attribution-hook')
    const claim = (await claimNext(jobs, 'worker'))!
    const jobId = claim.job.id
    expect(await reportResult(jobs, 'worker', jobId, claim.claimId, {
      backend: 'fixture', model: 'test', promptVersion: 'v1', durationMs: 1,
      fieldSuggestion: { kind: 'fields', stage: 'describe', fields: { description }, sources: ['https://example.org/source'] },
    })).toMatchObject({ ok: true })
    await observeQueueStage(jobs, run.id, 1, 0)
    saved.push({ runId: run.id, jobId })
  }
  const [first, last] = saved
  expect(await review.store.getEdit('batch', plates[0].id)).toMatchObject({
    fields: {},
    pipelineRunIds: [first.runId, last.runId],
    pipelineChanges: { description: { ...last, value: null, previous: 'Pipeline A', prior: [{ ...first, value: 'Pipeline A' }] } },
  })
  expect(await review.store.recentPlateIds?.('batch', 0)).toEqual([])
  expect(await revertPipelineField(review, actor, { batchId: 'batch', plateId: plates[0].id, field: 'description', jobId: last.jobId }))
    .toMatchObject({ value: { plate: { description: 'Pipeline A' } } })
  expect(await review.store.getEdit('batch', plates[0].id)).toMatchObject({
    fields: { description: 'Pipeline A' }, pipelineChanges: { description: { ...first, value: 'Pipeline A' } },
  })
  expect(await revertPipelineField(review, actor, { batchId: 'batch', plateId: plates[0].id, field: 'description', jobId: first.jobId }))
    .toMatchObject({ value: { plate: { description: null } } })
}, 20_000)

test('a configured Owner can still save a draft without a member record', async () => {
  const owner = { ...actor, role: 'owner' as const, uid: 'configured-owner' }
  const deps = { ...jobs, configuredOwnerUids: [owner.uid] }
  const result = await enqueueSelection(deps, owner, { requestId: 'configured-owner', batchId: 'batch', plateIds: [plates[0].id], stages: ['tag'] })
  if (!result.ok) throw Error(result.error)
  const [run] = result.value
  await dispatchQueueStage(deps, run.id, 1, 0, 'configured-owner-hook')
  const claim = (await claimNext(deps, 'worker'))!
  expect(await reportResult(deps, 'worker', claim.job.id, claim.claimId, {
    backend: 'fixture', model: 'test', promptVersion: 'v1', durationMs: 1, suggestions: ['configured owner result'],
  })).toMatchObject({ ok: true })
  await observeQueueStage(deps, run.id, 1, 0)
  expect(await review.store.getEdit('batch', plates[0].id)).toMatchObject({
    fields: { tags: ['configured owner result'] }, pipelineChanges: { tags: { by: owner.uid } },
  })
}, 20_000)
