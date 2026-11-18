import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMemoryStore } from '../../lib/review/memory-store'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { localJobsEnvironment } from '../../lib/jobs/local-scope'
import { enqueueRun } from '../../lib/jobs/queue'
import { bindQueueWorkflow, chooseQueueImage, dispatchQueueStage, observeQueueStage } from '../../lib/jobs/queue-engine'
import { claimNext, getJob, reportResult } from '../../lib/jobs/jobs'
import { applyQueueBundle } from '../../lib/jobs/queue-bundle'
import type { JobsDeps, ReportInput } from '../../lib/jobs/types'
import type { ReviewDeps } from '../../lib/review/types'
import type { Plate } from '../../lib/catalog/types'

const actor = { uid: 'editor', name: null, role: 'editor' as const }
const meta = { backend: 'fixture', model: 'fixture', promptVersion: 'connected', durationMs: 1 }
const bytes = Buffer.from('stored candidate fixture')
const candidate = { id: 'photo', title: 'Photo', imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Plate.jpg',
  sourceUrl: 'https://commons.wikimedia.org/wiki/File:Plate.jpg', width: 640, height: 320, sha256: createHash('sha256').update(bytes).digest('hex') }

async function setup(previewOnly = false, sameProvenance = false) {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const plates: Plate[] = ['one', 'two'].map((slug, index) => ({ id: `AK.${slug}`, slug, state: 'AK', displayName: slug, image: `${slug}.webp`, tags: [],
    templateFamily: `AK.${slug}`, templateRole: 'template', variantOfPlateId: null, isStandard: !!index,
    ...(sameProvenance ? { imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Old.jpg', sourceUrl: candidate.sourceUrl } : {}) }))
  const store = createMemoryStore([{ id: 'batch', name: 'Connected', createdBy: actor.uid, createdAt: '', revision: 0, baselineVersion: 1,
    plateIds: plates.map(plate => plate.id), stateOrders: { AK: plates.map(plate => plate.id) }, state: 'open', approval: null }])
  const baseline = async (id: string) => plates.find(plate => plate.id === id) ?? null
  let sequence = 0
  const jobs: JobsDeps = { store: createMemoryJobsStore(store, localJobsEnvironment('connected')), baseline, baselineAtVersion: async (_, id) => baseline(id),
    stateBaseline: async () => plates, localScope: 'connected', id: () => `claim-${++sequence}`, now: () => 100, leaseMs: 1000 }
  const review: ReviewDeps = { store, baseline, baselineAtVersion: async (_, id) => baseline(id), stateBaseline: async () => plates, now: () => '' }
  const result = await enqueueRun(jobs, actor, { requestId: 'connected', batchId: 'batch', plateIds: plates.map(plate => plate.id),
    stages: ['find-image', 'wiki-link', 'colors', 'describe', 'story', 'tag', 'group'], previewOnly })
  if (!result.ok) throw Error(result.error)
  const run = result.value
  await bindQueueWorkflow(jobs, run.id, 1, 'workflow')
  return { jobs, review, plates, run }
}

async function complete(s: Awaited<ReturnType<typeof setup>>) {
  for (let index = 0; index < s.run.attempts[0].steps.length; index++) {
    const id = await dispatchQueueStage({ ...s.jobs }, s.run.id, 1, index, `hook-${index}`)
    const claim = await claimNext({ ...s.jobs }, 'worker')
    expect(claim?.job.id).toBe(id)
    const job = claim!.job
    if (job.stage === 'find-image' || job.stage === 'wiki-link' || job.stage === 'group') expect(job).not.toHaveProperty('modelId')
    let result: ReportInput
    switch (job.stage) {
      case 'find-image': result = { ...meta, fieldSuggestion: { kind: 'image', stage: 'find-image', candidates: [candidate], sources: [candidate.imageUrl, candidate.sourceUrl] } }; break
      case 'wiki-link': result = { ...meta, fieldSuggestion: { kind: 'fields', stage: 'wiki-link', fields: { wikiUrl: 'https://en.wikipedia.org/wiki/Vehicle_registration_plates_of_Alaska' }, sources: ['https://en.wikipedia.org/wiki/Vehicle_registration_plates_of_Alaska'] } }; break
      case 'colors':
        expect(job.inputPlate?.imageUrl).toBe(candidate.imageUrl)
        result = { ...meta, fieldSuggestion: { kind: 'fields', stage: 'colors', fields: { colorDetail: 'Black text on white', lineageColor: 'white' }, sources: [candidate.imageUrl] } }; break
      case 'describe':
        expect(job.inputPlate?.wikiUrl).toContain('wikipedia.org')
        result = { ...meta, fieldSuggestion: { kind: 'fields', stage: 'describe', fields: { description: 'A sourced description' }, sources: [job.inputPlate!.wikiUrl!] } }; break
      case 'story':
        expect(job.inputPlate?.description).toBe('A sourced description')
        result = { ...meta, fieldSuggestion: { kind: 'fields', stage: 'story', fields: { funFacts: [{ text: 'A sourced fact', sourceUrl: job.inputPlate!.wikiUrl! }] }, sources: [job.inputPlate!.wikiUrl!] } }; break
      case 'group': {
        expect(job.standardId).toBe('AK.one')
        expect(job.groupScope).toHaveLength(2)
        expect(job.groupScope?.every(member => member.plate.imageUrl === candidate.imageUrl)).toBe(true)
        const scope = job.groupScope!.map(member => ({ plateId: member.plate.id, baseRevision: member.baseRevision }))
        result = { ...meta, fieldSuggestion: { kind: 'group', stage: 'group', scope, sources: [], proposals: scope.map(member => ({ ...member,
          fields: { templateFamily: 'AK.one', templateRole: member.plateId === 'AK.one' ? 'template' : 'variant', variantOfPlateId: member.plateId === 'AK.one' ? null : 'AK.one' } })) } }; break
      }
      default:
        expect(job.inputPlate?.imageUrl).toBe(candidate.imageUrl)
        result = { ...meta, suggestions: ['graphic'] }
    }
    expect(await reportResult(s.jobs, 'worker', job.id, claim!.claimId, result), job.stage ?? 'tag').toMatchObject({ ok: true })
    const observed = await observeQueueStage(s.jobs, s.run.id, 1, index)
    if (job.stage === 'find-image') {
      expect(observed.phase).toBe('waiting')
      expect((await s.jobs.store.transaction(tx => tx.runs()))[0].waitReason).toBe('image_choice')
      expect(await s.review.store.listEdits('batch')).toEqual([])
      expect(await chooseQueueImage(s.jobs, actor, s.run.id, job.id, 'untrusted')).toMatchObject({ error: 'invalid_state' })
      expect(await chooseQueueImage(s.jobs, actor, s.run.id, job.id, candidate.id)).toMatchObject({ ok: true })
      await observeQueueStage({ ...s.jobs }, s.run.id, 1, index)
    }
  }
  const [restored] = await s.jobs.store.transaction(tx => tx.runs())
  expect(restored.status).toBe('completed')
  expect(restored.attempts[0].steps.filter(step => step.stage === 'group')).toHaveLength(1)
  expect(await s.review.store.listEdits('batch')).toEqual([])
  return restored
}

beforeEach(() => vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1'))
afterEach(() => vi.unstubAllEnvs())

test('connected image choice → vision/reference → text → one Group restores and applies atomically, with original hashes', async () => {
  const s = await setup()
  const run = await complete(s)
  const read = vi.fn(async () => bytes)
  const commit = vi.spyOn(s.review.store, 'commit')
  expect(await applyQueueBundle(s.jobs, s.review, actor, run.id, read)).toMatchObject({ ok: true, value: { revision: 1 } })
  expect(commit).toHaveBeenCalledTimes(1)
  expect(await s.review.store.listEdits('batch')).toMatchObject([
    { fields: { imageUrl: candidate.imageUrl, sourceUrl: candidate.sourceUrl, description: 'A sourced description', tags: ['graphic'] } },
    { fields: { templateRole: 'variant', templateFamily: 'AK.one', variantOfPlateId: 'AK.one' } },
  ])
  expect(await applyQueueBundle(s.jobs, s.review, actor, run.id, read)).toMatchObject({ ok: true, value: { revision: 1 } })
  expect(commit).toHaveBeenCalledTimes(1)
  const first = await getJob(s.jobs, run.attempts[0].jobIds[0])
  expect(run.attempts[0].projection!.plates['AK.one'].batchInputHash).toBe(first?.inputHash)
  expect(read).toHaveBeenCalledTimes(2)
})

test('a description with no supported fields stops before dispatching Story', async () => {
  const s = await setup()
  const url = 'https://en.wikipedia.org/wiki/Vehicle_registration_plates_of_Alaska'
  const result = await enqueueRun(s.jobs, actor, { requestId: 'research', batchId: 'batch', plateIds: ['AK.one'], stages: ['wiki-link', 'describe', 'story'] })
  if (!result.ok) throw Error(result.error)
  const { id } = result.value
  await bindQueueWorkflow(s.jobs, id, 1, 'research-workflow')
  const reports: ReportInput[] = [
    { ...meta, fieldSuggestion: { kind: 'fields', stage: 'wiki-link', fields: { wikiUrl: url }, sources: [url] } },
    { ...meta, stageError: 'no_supported_fields' },
  ]
  for (const [index, report] of reports.entries()) {
    const jobId = await dispatchQueueStage(s.jobs, id, 1, index, `research-hook-${index}`)
    expect(jobId).not.toBeNull()
    const claim = (await claimNext(s.jobs, 'worker'))!
    expect(claim.job.id).toBe(jobId)
    if (index === 1) expect(claim.job.inputPlate?.wikiUrl).toBe(url)
    expect(await reportResult(s.jobs, 'worker', claim.job.id, claim.claimId, report)).toMatchObject({ ok: true })
    expect(await observeQueueStage(s.jobs, id, 1, index)).toEqual({ phase: index === 0 ? 'next' : 'done' })
  }
  expect(await dispatchQueueStage(s.jobs, id, 1, 2, 'story-hook')).toBeNull()
  expect(await claimNext(s.jobs, 'worker')).toBeNull()
  expect(await s.review.store.listEdits('batch')).toEqual([])
  const saved = (await s.jobs.store.transaction(tx => tx.runs())).find(run => run.id === id)
  expect(saved).toMatchObject({ status: 'failed', attempts: [{ cursor: 3, outcome: 'no_result', error: 'no_supported_fields',
    steps: [{ status: 'completed' }, { status: 'failed' }, { status: 'skipped', reason: 'upstream_failed' }] }] })
  expect(saved?.attempts[0].projection?.plates['AK.one'].executionPlate.wikiUrl).toBe(url)
})

test('Preview connected results refuse Apply before network or writes; normal image checksum mismatch writes nothing', async () => {
  for (const previewOnly of [true, false]) {
    const s = await setup(previewOnly)
    await complete(s)
    const read = vi.fn(async () => Buffer.from('changed bytes'))
    const commit = vi.spyOn(s.review.store, 'commit')
    expect(await applyQueueBundle(s.jobs, s.review, actor, s.run.id, read)).toMatchObject({ error: previewOnly ? 'forbidden' : 'invalid_state' })
    expect(commit).not.toHaveBeenCalled()
    if (previewOnly) expect(read).not.toHaveBeenCalled()
  }
})

test('a new image with unchanged provenance is still verified and parsed as a paired image change', async () => {
  const s = await setup(false, true)
  await complete(s)
  expect(await applyQueueBundle(s.jobs, s.review, actor, s.run.id, async () => bytes)).toMatchObject({ ok: true })
  expect((await s.review.store.getEdit('batch', 'AK.one'))?.fields.imageUrl).toBe(candidate.imageUrl)
})

test('Group membership is mandatory at enqueue, dispatch and aggregate Apply, without implicitly adding plates', async () => {
  const s = await setup(true)
  const batch = (await s.review.store.getBatch('batch'))!
  await s.review.store.commit('batch', 0, { batch: { ...batch, revision: 1, plateIds: ['AK.one'] } })
  expect(await enqueueRun(s.jobs, actor, { requestId: 'outside', batchId: 'batch', plateIds: ['AK.one', 'AK.two'], stages: ['group'], previewOnly: true })).toMatchObject({ error: 'invalid_state' })
  const index = s.run.attempts[0].steps.length - 1
  await s.jobs.store.transaction(async tx => { const [run] = await tx.runs(); run.attempts[0].cursor = index; tx.setRun(run) })
  expect(await dispatchQueueStage(s.jobs, s.run.id, 1, index, 'group')).toBeNull()
  expect(await s.review.store.listEdits('batch')).toEqual([])
  const normal = await setup()
  await complete(normal)
  const current = (await normal.review.store.getBatch('batch'))!
  await normal.review.store.commit('batch', 0, { batch: { ...current, revision: 1, plateIds: ['AK.one'] } })
  expect(await applyQueueBundle(normal.jobs, normal.review, actor, normal.run.id, async () => bytes)).toMatchObject({ error: 'invalid_state' })
  expect(await normal.review.store.listEdits('batch')).toEqual([])
})

