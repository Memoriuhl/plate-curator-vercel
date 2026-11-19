import { createHash } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import { createMemoryStore } from '../../lib/review/memory-store'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { plateRevision } from '../../lib/review/revision'
import { reportLocalWorkerCapabilities } from '../../lib/jobs/capabilities'
import { groupProposal } from '../../worker/image-group'
import type { JobsDeps, TaggingJob } from '../../lib/jobs/types'
import type { ReviewDeps } from '../../lib/review/types'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  worker: vi.fn(),
  reviews: vi.fn(),
  jobs: vi.fn(),
  changed: vi.fn(),
}))
vi.mock('../../lib/server/context', () => ({
  currentActor: mocks.auth,
  currentWorker: mocks.worker,
  reviewDeps: mocks.reviews,
  jobsDeps: mocks.jobs,
  /** Select the fixture desktop vision model for the grouping route. */ chooseModel:
    () => ({ ok: true, model: { id: 'desktop-gemma4-12b' } }),
}))
vi.mock('../../lib/server/catalog-head', () => ({
  catalogChanged: mocks.changed,
}))
vi.mock('../../worker/remote-image', () => ({
  /** Return known image bytes so candidate verification runs without a real download. */ readCommonsImage:
    async () => Buffer.from('verified image'),
}))

const { POST: imageAccept } =
  await import('../../app/api/batches/[id]/images/accept/route')
const { POST: groupCreate } =
  await import('../../app/api/batches/[id]/group/route')
const { POST: groupAccept } =
  await import('../../app/api/batches/[id]/group/accept/route')
const { PATCH: patch } =
  await import('../../app/api/batches/[id]/plates/[plateId]/route')
const { GET: getCapabilities } =
  await import('../../app/api/local-pipeline/capabilities/route')
const { POST: capabilityReport } =
  await import('../../app/api/worker/capabilities/route')

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})
const ctx = { params: Promise.resolve({ id: 'batch' }) }
/** Build the POST request the route fixture passes to its handler. */
const post = (body: unknown) =>
  new Request('http://localhost', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

/**
 * Prepare authenticated route dependencies, fixture jobs and verified grouping or image
 * input.
 */
async function setup() {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const actor = { uid: 'editor', role: 'editor' as const, name: null }
  const plates = ['a', 'b'].map((id) => ({
    id: `AK.${id}`,
    state: 'AK',
    slug: id,
    displayName: id,
    image: `${id}.webp`,
    tags: [],
    templateRole: 'template' as const,
    templateFamily: `AK.${id}`,
    isStandard: id === 'a',
  }))
  const store = createMemoryStore([
    {
      id: 'batch',
      kind: 'shared-draft',
      name: 'Batch',
      createdBy: actor.uid,
      createdAt: '',
      state: 'open',
      revision: 0,
      baselineVersion: 1,
      approval: null,
      plateIds: plates.map((plate) => plate.id),
      stateOrders: { AK: plates.map((plate) => plate.id) },
    },
  ])
  const d: ReviewDeps = {
    store,
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
    store: createMemoryJobsStore(store, 'development'),
    baseline: d.baseline,
    baselineAtVersion: d.baselineAtVersion,
    stateBaseline: d.stateBaseline,
    localScope: 'scope',
    /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () =>
      1000,
    /** Supply a deterministic ID so the test can identify the generated record. */ id: () =>
      'claim',
    leaseMs: 10000,
  }
  mocks.auth.mockResolvedValue({ ok: true, actor })
  mocks.worker.mockResolvedValue({ ok: true, workerId: 'worker' })
  mocks.reviews.mockReturnValue(d)
  mocks.jobs.mockReturnValue(jobs)
  const candidate = {
    id: 'candidate',
    title: 'Photo',
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Plate.jpg',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Plate.jpg',
    width: 640,
    height: 320,
    sha256: createHash('sha256').update('verified image').digest('hex'),
  }
  const job: TaggingJob = {
    id: 'image',
    batchId: 'batch',
    plateId: plates[0].id,
    requestedBy: actor.uid,
    inputHash: plateRevision(plates[0]),
    env: 'development',
    localScope: 'scope',
    stage: 'find-image',
    state: 'completed',
    createdAt: 0,
    result: {
      suggestions: [],
      fieldSuggestion: {
        kind: 'image',
        stage: 'find-image',
        candidates: [candidate],
        sources: [candidate.imageUrl, candidate.sourceUrl],
      },
      model: 'search',
      backend: 'search',
      promptVersion: 'fixture',
      durationMs: 0,
    },
  }
  await jobs.store.transaction(async (tx) => {
    tx.create(job)
  })
  return { d, jobs, plates, candidate, job }
}

test('actual PATCH rejects arbitrary/null/unpaired provenance and accept route selects stored candidate', async () => {
  const s = await setup()
  for (const fields of [
    { imageUrl: s.candidate.imageUrl, sourceUrl: 'https://example.org' },
    { imageUrl: s.candidate.imageUrl, sourceUrl: null },
    { sourceUrl: s.candidate.sourceUrl },
  ]) {
    expect(
      (
        await patch(
          new Request('http://localhost', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseRevision: s.job.inputHash, fields }),
          }),
          { params: Promise.resolve({ id: 'batch', plateId: s.plates[0].id }) }
        )
      ).status
    ).toBe(400)
  }
  expect(await s.d.store.listEdits('batch')).toEqual([])
  expect(
    (
      await imageAccept(
        post({
          jobId: 'image',
          candidateId: 'forged',
          baseRevision: s.job.inputHash,
        }),
        ctx
      )
    ).status
  ).toBe(422)
  expect(
    (
      await imageAccept(
        post({
          jobId: 'image',
          candidateId: 'candidate',
          baseRevision: s.job.inputHash,
          sourceUrl: 'https://example.org',
        }),
        ctx
      )
    ).status
  ).toBe(200)
  expect((await s.d.store.getEdit('batch', s.plates[0].id))?.fields).toEqual({
    imageUrl: s.candidate.imageUrl,
    sourceUrl: s.candidate.sourceUrl,
  })
})

test('actual Group route uses server scope and its worker-reported capability', async () => {
  const s = await setup()
  const request = {
    plateIds: s.plates.map((plate) => plate.id),
    batchRevision: 0,
    groupScope: [{ plate: { id: 'forged' } }],
  }
  expect((await groupCreate(post(request), ctx)).status).toBe(422)
  await reportLocalWorkerCapabilities(s.jobs, 'worker', {
    group: { available: true },
    embeddings: { available: true },
    mask: { available: true },
    vision: { available: false, reason: 'No vision' },
    pollIntervalMs: 5000,
  })
  const response = await groupCreate(post(request), ctx)
  expect(response.status).toBe(202)
  const { jobId } = await response.json()
  const job = await s.jobs.store.transaction((tx) => tx.get(jobId))
  expect(job?.groupScope?.map((member) => member.plate.id)).toEqual([
    'AK.a',
    'AK.b',
  ])
  expect(job?.standardId).toBe('AK.a')
  expect(
    (await groupAccept(post({ jobId, batchRevision: 0, suggestion: {} }), ctx))
      .status
  ).toBe(422)
  expect(await s.d.store.listEdits('batch')).toEqual([])
  expect((await getCapabilities(new Request('http://localhost'))).status).toBe(
    200
  )
  if (!job?.groupScope) throw Error('Missing created Group scope')
  const suggestion = groupProposal(
    job.groupScope,
    {
      model: 'fixture',
      groups: [{ templateId: 'AK.b', variants: [{ id: 'AK.a' }] }],
      similarities: [],
    },
    job.standardId
  )!
  await s.jobs.store.transaction(async (tx) => {
    tx.set({
      ...job,
      state: 'completed',
      result: {
        suggestions: [],
        fieldSuggestion: suggestion,
        backend: 'fixture',
        model: 'fixture',
        promptVersion: 'fixture',
        durationMs: 0,
      },
    })
  })
  const commit = vi.spyOn(s.d.store, 'commit')
  const accepted = await groupAccept(
    post({
      jobId,
      batchRevision: 0,
      suggestion: { scope: ['forged'] },
      fields: { deleted: true },
    }),
    ctx
  )
  expect(accepted.status).toBe(200)
  expect(commit).toHaveBeenCalledTimes(1)
  expect((await s.d.store.getBatch('batch'))?.revision).toBe(1)
  const edits = await s.d.store.listEdits('batch')
  expect(edits).toHaveLength(2)
  expect(edits.find((edit) => edit.plateId === 'AK.b')?.fields).toMatchObject({
    templateRole: 'variant',
    variantOfPlateId: 'AK.a',
    templateFamily: 'AK.a',
  })
  expect(edits.every((edit) => edit.fields.deleted === undefined)).toBe(true)
})

test('stored preview jobs reject both accept routes and cannot be converted by request payload', async () => {
  const s = await setup()
  const groupScope = s.plates.map((plate) => ({
    plate,
    baseRevision: plateRevision(plate),
  }))
  const suggestion = groupProposal(
    groupScope,
    {
      model: 'fixture',
      groups: [{ templateId: 'AK.a', variants: [{ id: 'AK.b' }] }],
      similarities: [],
    },
    'AK.a'
  )!
  await s.jobs.store.transaction(async (tx) => {
    tx.set({ ...s.job, previewOnly: true })
    tx.create({
      ...s.job,
      id: 'group',
      stage: 'group',
      previewOnly: true,
      groupScope,
      standardId: 'AK.a',
      result: {
        suggestions: [],
        fieldSuggestion: suggestion,
        backend: 'fixture',
        model: 'fixture',
        promptVersion: 'fixture',
        durationMs: 0,
      },
    })
  })
  const commit = vi.spyOn(s.d.store, 'commit')
  expect(
    (
      await imageAccept(
        post({
          jobId: 'image',
          candidateId: 'candidate',
          baseRevision: s.job.inputHash,
          previewOnly: false,
        }),
        ctx
      )
    ).status
  ).toBe(422)
  expect(
    (
      await groupAccept(
        post({ jobId: 'group', batchRevision: 0, previewOnly: false }),
        ctx
      )
    ).status
  ).toBe(422)
  const unsupported = await groupCreate(
    post({
      plateIds: s.plates.map((plate) => plate.id),
      batchRevision: 0,
      previewOnly: true,
    }),
    ctx
  )
  expect(unsupported.status).toBe(422)
  expect((await unsupported.json()).reason).toContain('Standalone preview-only')
  expect(commit).not.toHaveBeenCalled()
  expect(await s.d.store.listEdits('batch')).toEqual([])
  expect((await s.d.store.getBatch('batch'))?.revision).toBe(0)
})

test('local routes and capability writes remain off without the flag', async () => {
  await setup()
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  mocks.auth.mockClear()
  mocks.worker.mockClear()
  expect((await imageAccept(post({}), ctx)).status).toBe(404)
  expect((await groupCreate(post({}), ctx)).status).toBe(404)
  expect((await groupAccept(post({}), ctx)).status).toBe(404)
  expect((await getCapabilities(new Request('http://localhost'))).status).toBe(
    404
  )
  expect((await capabilityReport(post({}))).status).toBe(404)
  expect(mocks.auth).not.toHaveBeenCalled()
  expect(mocks.worker).not.toHaveBeenCalled()
})
