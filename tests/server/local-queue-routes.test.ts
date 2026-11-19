import sharp from 'sharp'
import { createEnhanceImageRunner } from '../../worker/enhance-image'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { sharedDraftId } from '../../lib/review/draft/draft-id'
import { ensureDraft } from '../../lib/review/draft/draft'
import { reorderState } from '../../lib/review/batches/batch'
import { draftPublishSummary } from '../../lib/review/publish-view'
import { localJobsEnvironment } from '../../lib/jobs/local-scope'
import {
  dispatchQueueStage,
  observeQueueStage,
} from '../../lib/jobs/queue/queue-engine'
import { claimNext, getJob, reportResult } from '../../lib/jobs/jobs'
import { enqueueRun } from '../../lib/jobs/queue/queue'
import type { JobsDeps } from '../../lib/jobs/types'
import { GET, POST } from '../../app/api/local-pipeline/runs/route'
import { POST as createSelection } from '../../app/api/local-pipeline/runs/selection/route'
import { POST as cancel } from '../../app/api/local-pipeline/runs/[id]/cancel/route'
import { POST as claim } from '../../app/api/worker/claim/route'
import { POST as report } from '../../app/api/worker/jobs/[id]/report/route'
import { GET as getEnhancedImage } from '../../app/api/local-pipeline/jobs/[id]/enhanced-image/route'

import { GET as getLatestEnhancement } from '../../app/api/local-pipeline/plates/[id]/enhancement/route'
import { POST as postProgress } from '../../app/api/worker/jobs/[id]/progress/route'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  jobs: vi.fn(),
  start: vi.fn(),
  resume: vi.fn(),
  workflow: vi.fn(),
  review: vi.fn(),
}))
vi.mock('../../lib/server/context', () => ({
  currentActor: mocks.auth,
  jobsDeps: mocks.jobs,
  /** Authenticate a fixture worker for the queue report endpoints. */ currentWorker:
    async () => ({ ok: true, workerId: 'worker' }),
  /** Supply isolated review dependencies to the route or workflow under test. */ reviewDeps:
    () => mocks.review(),
  /** Scope the shared draft to the fixture environment. */ reviewEnv: () =>
    'route-test',
  /** Provide the catalog source needed to validate a queue selection. */ catalog:
    () => ({
      /** Return the fixed baseline version for the fixture's local queue requests. */ readSnapshot:
        async () => ({ version: 1 }),
    }),
}))
vi.mock('../../lib/server/catalog-head', () => ({ catalogChanged: vi.fn() }))
vi.mock('workflow/api', () => ({
  start: mocks.start,
  resumeHook: mocks.resume,
  getRun: mocks.workflow,
}))
const actor = { uid: 'editor', role: 'editor' as const, name: null }
const body = {
  requestId: 'request',
  batchId: 'batch',
  plateIds: ['AK.one'],
  stages: ['tag'],
}
/** Build the POST request the route fixture passes to its handler. */
const post = () =>
  new Request('https://example.org/api/local-pipeline/runs', {
    method: 'POST',
    body: JSON.stringify(body),
  })
/** Build the GET request the route fixture passes to its handler. */
const get = () => new Request('https://example.org/api/local-pipeline/runs')
const getDetail = (id: string) =>
  GET(new Request(`${get().url}?detail=${encodeURIComponent(id)}&detailOnly=1`))
let deps: JobsDeps

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const plate = {
    id: 'AK.one',
    state: 'AK',
    slug: 'one',
    displayName: 'One',
    image: '',
    tags: [],
  }
  const review = createMemoryStore([
    {
      id: 'batch',
      kind: 'shared-draft',
      name: 'Queue',
      createdBy: actor.uid,
      createdAt: '',
      revision: 0,
      state: 'open',
      baselineVersion: 1,
      plateIds: [plate.id],
      approval: null,
    },
  ])
  mocks.review.mockReturnValue({
    store: review,
    baseline: async () => plate,
    baselineAtVersion: async () => plate,
    stateBaseline: async () => [plate],
    now: () => '2026-11-18T12:00:00.000Z',
    liveVersion: async () => 1,
  })
  deps = {
    store: createMemoryJobsStore(review, localJobsEnvironment('route-test')),
    localScope: 'route-test',
    /** Supply the test plate as the catalog baseline. */ baseline: async () =>
      plate,
    /** Pin the operation clock so timestamps and lease checks are reproducible. */
    now: () => 100,
    /** Supply a deterministic ID so the test can identify the generated record. */ id: () =>
      'claim',
    leaseMs: 1000,
  }
  mocks.auth.mockReset().mockResolvedValue({ ok: true, actor })
  mocks.jobs.mockReset().mockReturnValue(deps)
  mocks.start.mockReset().mockResolvedValue({ runId: 'workflow' })
  mocks.resume.mockReset().mockResolvedValue(undefined)
  mocks.workflow
    .mockReset()
    .mockReturnValue({ status: Promise.resolve('running') })
})
afterEach(() => vi.unstubAllEnvs())

test('authenticated enqueue starts installed Workflow once with an attempt token; reload restores stable run ID and summaries omit snapshots', async () => {
  const added = await POST(post())
  expect(added.status).toBe(202)
  expect(await added.json()).toMatchObject({ run: { incrementalDrafts: true } })
  expect((await POST(post())).status).toBe(202)
  expect(mocks.start).toHaveBeenCalledTimes(1)
  expect(mocks.start.mock.calls[0][2].experimental_hook.token).toMatch(
    /^local-pipeline-start:route-test:/
  )
  const restored = await (await GET(get())).json()
  expect(restored.runs).toHaveLength(1)
  expect(restored.runs[0].attempts[0]).not.toHaveProperty('projection')
  expect(restored.runs[0].attempts[0]).not.toHaveProperty('steps')
  expect(restored.runs[0].attempts[0]).toMatchObject({
    stepCount: 1,
    completedCount: 0,
  })
  expect(restored.selected.attempts[0].projection).toBeTruthy()
  expect(restored.selected.cards).toMatchObject([
    {
      id: 'AK.one',
      displayName: 'One',
      checks: { tags: { status: 'missing' } },
    },
  ])
  expect(restored.runs[0]).not.toHaveProperty('cards')
  expect(restored.selected.id).toBe(restored.runs[0].id)
  expect(restored.runs[0].progress).toMatchObject({
    steps: [{ stage: 'tag', status: 'queued', plateName: 'One' }],
    workerIds: [],
  })
  expect(restored.runs[0].progress.steps[0]).not.toHaveProperty('inputPlate')
})

test('enqueue acknowledgement loss/start failure recovers the same persisted run on retry or GET', async () => {
  mocks.start.mockRejectedValueOnce(new Error('Temporary start failure'))
  expect((await POST(post())).status).toBe(503)
  expect(await deps.store.transaction((tx) => tx.runs())).toHaveLength(1)
  const result = await (await GET(get())).json()
  expect(result.runs).toHaveLength(1)
  expect(
    (await deps.store.transaction((tx) => tx.runs()))[0].attempts[0].workflowId
  ).toBe('workflow')
})

test('claim callback wakes the persisted lease; a lost completed callback is not woken by GET, which creates no other stage job', async () => {
  await POST(post())
  const [run] = await deps.store.transaction((tx) => tx.runs())
  const token = 'local-pipeline-stage'
  await dispatchQueueStage(deps, run.id, 1, 0, token)
  const response = await claim(
    new Request('https://example.org/api/worker/claim', { method: 'POST' })
  )
  expect(response.status).toBe(200)
  const claimed = await response.json()
  expect(mocks.resume).toHaveBeenCalledWith(token, { jobId: claimed.job.id })
  expect(await observeQueueStage(deps, run.id, 1, 0)).toMatchObject({
    phase: 'claimed',
    deadline: 600100,
  })
  await reportResult(deps, 'worker', claimed.job.id, claimed.claimId, {
    suggestions: ['blue'],
    backend: 'fixture',
    model: 'test',
    promptVersion: 'v1',
    durationMs: 10,
  })
  mocks.resume.mockClear()
  // Reads leave the lost wake to the workflow's own re-check and create no stage job.
  await getDetail(run.id)
  expect(mocks.resume).not.toHaveBeenCalled()
  expect((await getJob(deps, claimed.job.id))?.state).toBe('completed')
  expect(await deps.store.transaction((tx) => tx.list())).toHaveLength(1)
})

/** Report the claimed job's result through the worker report route. */
const reportRoute = (id: string, claimId: string) =>
  report(
    new Request(`https://example.org/api/worker/jobs/${id}/report`, {
      method: 'POST',
      body: JSON.stringify({
        claimId,
        suggestions: ['blue'],
        backend: 'fixture',
        model: 'test',
        promptVersion: 'v1',
        durationMs: 10,
      }),
    }),
    { params: Promise.resolve({ id }) }
  )

/** Queue one stage and let the worker claim it through the claim route. */
async function claimedStage() {
  await POST(post())
  const [run] = await deps.store.transaction((tx) => tx.runs())
  const token = 'local-pipeline-stage'
  await dispatchQueueStage(deps, run.id, 1, 0, token)
  const claimed = await (
    await claim(
      new Request('https://example.org/api/worker/claim', { method: 'POST' })
    )
  ).json()
  expect(mocks.resume).toHaveBeenCalledWith(token, { jobId: claimed.job.id })
  mocks.resume.mockClear()
  return { run, token, claimed }
}

test('reads never wake the workflow, even when the report wake was lost', async () => {
  const { run, claimed } = await claimedStage()
  await GET(get())
  // The worker's report commits, but its wake never reaches the workflow.
  await reportResult(deps, 'worker', claimed.job.id, claimed.claimId, {
    suggestions: ['blue'],
    backend: 'fixture',
    model: 'test',
    promptVersion: 'v1',
    durationMs: 10,
  })
  await getDetail(run.id)
  await GET(get())
  mocks.jobs.mockReturnValue({ ...deps, now: () => 100 + 60 * 60_000 })
  await getDetail(run.id)
  expect(mocks.resume).not.toHaveBeenCalled()
})

test('a repeated wake only re-reads the stage: observing twice settles it once', async () => {
  const { run, claimed } = await claimedStage()
  await reportResult(deps, 'worker', claimed.job.id, claimed.claimId, {
    suggestions: ['blue'],
    backend: 'fixture',
    model: 'test',
    promptVersion: 'v1',
    durationMs: 10,
  })
  const first = await observeQueueStage(deps, run.id, 1, 0)
  const runs = await deps.store.transaction((tx) => tx.runs())
  const jobs = await deps.store.transaction((tx) => tx.list())
  expect(await observeQueueStage(deps, run.id, 1, 0)).toEqual(first)
  expect(await deps.store.transaction((tx) => tx.runs())).toEqual(runs)
  expect(await deps.store.transaction((tx) => tx.list())).toEqual(jobs)
})

test('the claim and report replies never wait for their workflow wakes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await POST(post())
    const [run] = await deps.store.transaction((tx) => tx.runs())
    await dispatchQueueStage(deps, run.id, 1, 0, 'local-pipeline-stage')
    mocks.resume.mockReturnValue(new Promise(() => {}))
    const response = await claim(
      new Request('https://example.org/api/worker/claim', { method: 'POST' })
    )
    expect(response.status).toBe(200)
    const claimed = await response.json()
    expect((await reportRoute(claimed.job.id, claimed.claimId)).status).toBe(
      200
    )
    expect(mocks.resume).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})

test('authentication and other-owner visibility/mutations reject without exposing runs', async () => {
  mocks.auth.mockResolvedValueOnce({
    ok: false,
    response: Response.json({ error: 'unauthenticated' }, { status: 401 }),
  })
  expect((await POST(post())).status).toBe(401)
  expect(mocks.jobs).not.toHaveBeenCalled()
  // A run from before the cutover, on the creator's own Batch.
  await mocks.review().store.create({
    id: 'legacy',
    name: 'Old Batch',
    createdBy: actor.uid,
    createdByName: null,
    createdAt: '',
    revision: 0,
    state: 'open',
    baselineVersion: 1,
    plateIds: ['AK.one'],
    stateOrders: {},
    approval: null,
  })
  const created = await enqueueRun(deps, actor, {
    ...body,
    batchId: 'legacy',
    stages: ['tag'],
  })
  if (!created.ok) throw new Error(created.error)
  const run = created.value
  mocks.auth.mockResolvedValue({ ok: true, actor: { ...actor, uid: 'other' } })
  expect(await (await GET(get())).json()).toMatchObject({
    runs: [],
    orphanJobs: [],
    observedAt: 100,
    capabilities: { previewOnly: { available: true } },
  })
  expect(
    (
      await cancel(new Request('https://example.org', { method: 'POST' }), {
        params: Promise.resolve({ id: run.id }),
      })
    ).status
  ).toBe(403)
  expect(
    await claimNext({ ...deps, localScope: undefined }, 'production')
  ).toBeNull()
})

test('a run enqueued on an old Batch answers 409 and queues nothing', async () => {
  await mocks.review().store.create({
    id: 'legacy',
    name: 'Old Batch',
    createdBy: actor.uid,
    createdByName: null,
    createdAt: '',
    revision: 0,
    state: 'open',
    baselineVersion: 1,
    plateIds: ['AK.one'],
    stateOrders: {},
    approval: null,
  })
  const single = await POST(
    new Request(get().url, {
      method: 'POST',
      body: JSON.stringify({ ...body, batchId: 'legacy' }),
    })
  )
  expect(single.status).toBe(409)
  expect(await single.json()).toMatchObject({ error: 'history_read_only' })
  const selection = await createSelection(
    new Request(`${get().url}/selection`, {
      method: 'POST',
      body: JSON.stringify({ ...body, batchId: 'legacy' }),
    })
  )
  expect(selection.status).toBe(409)
  const missing = await POST(
    new Request(get().url, {
      method: 'POST',
      body: JSON.stringify({ ...body, batchId: 'missing' }),
    })
  )
  expect(missing.status).toBe(404)
  expect(await deps.store.transaction((tx) => tx.runs())).toEqual([])
  expect(mocks.start).not.toHaveBeenCalled()
})

test('detail only reads one authorized run and its saved jobs without scanning the queue', async () => {
  const { run } = await (await POST(post())).json()
  const { run: other } = await (
    await POST(
      new Request(get().url, {
        method: 'POST',
        body: JSON.stringify({ ...body, requestId: 'other-run' }),
      })
    )
  ).json()
  const jobId = await dispatchQueueStage(deps, run.id, 1, 0, 'detail-hook')
  const store = deps.store
  const scan = vi.fn(() => {
    throw new Error('A detail read should not scan the queue')
  })
  mocks.jobs.mockReturnValue({
    ...deps,
    store: {
      ...store,
      transaction: (work) =>
        store.transaction((tx) => work({ ...tx, runs: scan, list: scan })),
    },
  } satisfies JobsDeps)

  const response = await getDetail(run.id)
  expect(response.status).toBe(200)
  const result = await response.json()
  expect(result).toMatchObject({
    runs: [{ id: run.id }],
    selected: { id: run.id, jobs: [{ id: jobId }], cards: [{ id: 'AK.one' }] },
  })
  expect(result).not.toHaveProperty('orphanJobs')
  expect(result.runs[0]).not.toHaveProperty('cards')
  expect(result.runs[0].attempts[0]).not.toHaveProperty('projection')
  expect(JSON.stringify(result)).not.toContain(other.id)

  mocks.auth.mockResolvedValue({ ok: true, actor: { ...actor, uid: 'other' } })
  expect((await getDetail(run.id)).status).toBe(404)
  mocks.auth.mockResolvedValue({
    ok: true,
    actor: { uid: 'owner', role: 'owner', name: null },
  })
  expect((await getDetail(run.id)).status).toBe(200)
  expect((await getDetail('missing-run')).status).toBe(404)
  expect(scan).not.toHaveBeenCalled()
})

test('GET records an actual exhausted Workflow failure as retryable failure when no physical stage is active', async () => {
  await POST(post())
  mocks.workflow.mockReturnValue({ status: Promise.resolve('failed') })
  const restored = await (await GET(get())).json()
  expect(restored.runs[0]).toMatchObject({
    status: 'failed',
    attempts: [{ error: 'workflow_failed' }],
  })
  expect(mocks.start).toHaveBeenCalledTimes(1)
})

test('a named selection from an older client lands in the shared draft instead of a new Batch', async () => {
  /** Build the POST request the route fixture passes to its handler. */
  const request = () =>
    new Request('https://example.org/api/local-pipeline/runs/selection', {
      method: 'POST',
      body: JSON.stringify({
        requestId: body.requestId,
        plateIds: body.plateIds,
        stages: body.stages,
        batchName: 'New Alaska draft',
      }),
    })
  const initial = await createSelection(request())
  expect(initial.status).toBe(202)
  const value = await initial.json()
  expect(value.batchId).toBe(sharedDraftId('route-test'))
  expect(value).toMatchObject({
    run: { incrementalDrafts: true, batchId: value.batchId },
    runIds: [value.run.id],
  })
  expect(
    await deps.store.transaction((tx) => tx.batch(value.batchId))
  ).toMatchObject({ kind: 'shared-draft', state: 'open', baselineVersion: 1 })
  expect(await (await createSelection(request())).json()).toMatchObject({
    batchId: value.batchId,
    runIds: value.runIds,
  })
  expect(mocks.start).toHaveBeenCalledTimes(1)
})

test('a run started against the draft alias writes into the shared draft', async () => {
  const response = await POST(
    new Request('https://example.org/api/local-pipeline/runs', {
      method: 'POST',
      body: JSON.stringify({ ...body, requestId: 'alias', batchId: 'draft' }),
    })
  )
  expect(response.status).toBe(202)
  expect((await response.json()).run).toMatchObject({
    batchId: sharedDraftId('route-test'),
  })
})

test('enhancement options reach the capable worker and the completed WebP is private to the run', async () => {
  const options = {
    'enhance-image': { upscale: false, crop: false, roundCorners: true },
  }
  const payload = { ...body, stages: ['enhance-image'], options }
  const request = (value: object) =>
    new Request('https://example.org', {
      method: 'POST',
      body: JSON.stringify(value),
    })
  expect(
    (
      await POST(
        request({
          ...payload,
          options: {
            'enhance-image': {
              ...options['enhance-image'],
              roundCorners: false,
            },
          },
        })
      )
    ).status
  ).toBe(400)
  expect((await POST(request(payload))).status).toBe(202)
  const [run] = await deps.store.transaction((tx) => tx.runs())
  await dispatchQueueStage(deps, run.id, 1, 0, 'worker-stage')
  expect((await claim(request({}))).status).toBe(204)
  const available = { available: true }
  const capabilities = {
    group: available,
    embeddings: available,
    mask: available,
    vision: available,
    enhanceImage: available,
    pollIntervalMs: 1000,
  }
  const claimed = await (await claim(request({ capabilities }))).json()
  expect(claimed).toMatchObject({
    stage: 'enhance-image',
    stageOptions: options['enhance-image'],
  })
  const input = await sharp({
    create: { width: 160, height: 80, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer()
  const result = await createEnhanceImageRunner(async () =>
    input.toString('base64')
  )({
    stage: claimed.stage,
    plate: { ...claimed.plate, image: 'AK/one.webp' },
    options: claimed.stageOptions,
  })
  const route = { params: Promise.resolve({ id: claimed.job.id }) }
  expect(
    (await postProgress(request({ claimId: 'wrong', index: 1 }), route)).status
  ).toBe(409)
  expect(
    (await postProgress(request({ claimId: claimed.claimId, index: 2 }), route))
      .status
  ).toBe(400)
  expect(
    (await postProgress(request({ claimId: claimed.claimId, index: 1 }), route))
      .status
  ).toBe(204)
  expect(
    (await postProgress(request({ claimId: claimed.claimId, index: 0 }), route))
      .status
  ).toBe(204)
  expect(await getJob(deps, claimed.job.id)).toMatchObject({ phaseIndex: 1 })
  expect(
    (
      await report(
        request({ ...result, claimId: claimed.claimId, durationMs: 10 }),
        route
      )
    ).status
  ).toBe(200)
  expect(await observeQueueStage(deps, run.id, 1, 0)).toEqual({ phase: 'done' })
  const response = await getEnhancedImage(get(), route)
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await response.json()).toEqual({ image: result.enhancedImage })
  const preview = (step: string) =>
    getEnhancedImage(new Request(`https://example.org?step=${step}`), route)
  expect(await (await preview('original')).json()).toEqual({
    image: result.enhancedImageFrames?.[0],
  })
  expect(await (await preview('roundCorners')).json()).toEqual({
    image: result.enhancedImage,
  })
  expect((await preview('upscale')).status).toBe(404)
  const latest = () =>
    getLatestEnhancement(get(), { params: Promise.resolve({ id: 'AK.one' }) })
  expect(await (await latest()).json()).toMatchObject({
    result: {
      jobId: claimed.job.id,
      suggestion: {
        frames:
          result.fieldSuggestion?.kind === 'enhanced-image'
            ? result.fieldSuggestion.frames
            : undefined,
      },
    },
  })
  mocks.auth.mockResolvedValue({ ok: true, actor: { ...actor, uid: 'other' } })
  expect(await (await latest()).json()).toEqual({ result: null })
  expect((await getEnhancedImage(get(), route)).status).toBe(404)
})

test('reordering Alaska, then a pipeline run on Alabama, keeps the Alaska order and Publish shows both states', async () => {
  const plates = [
    {
      id: 'AK.one',
      state: 'AK',
      slug: 'one',
      displayName: 'One',
      image: '',
      tags: [],
    },
    {
      id: 'AK.two',
      state: 'AK',
      slug: 'two',
      displayName: 'Two',
      image: '',
      tags: [],
    },
    {
      id: 'AK.three',
      state: 'AK',
      slug: 'three',
      displayName: 'Three',
      image: '',
      tags: [],
    },
    {
      id: 'AL.one',
      state: 'AL',
      slug: 'al',
      displayName: 'Al',
      image: '',
      tags: [],
    },
  ]
  const find = async (id: string) =>
    plates.find((plate) => plate.id === id) ?? null
  const review = createMemoryStore([])
  const reviewDeps = {
    store: review,
    baseline: find,
    baselineAtVersion: async (_version: number, id: string) => find(id),
    stateBaseline: async (_version: number, state: string) =>
      plates.filter((plate) => plate.state === state),
    now: () => '2026-11-18T12:00:00.000Z',
    liveVersion: async () => 1,
  }
  mocks.review.mockReturnValue(reviewDeps)
  deps.store = createMemoryJobsStore(review, localJobsEnvironment('route-test'))
  deps.baseline = find
  const draftId = sharedDraftId('route-test')
  const draft = await ensureDraft(reviewDeps, 'route-test', actor)
  expect(
    await reorderState(reviewDeps, actor, {
      batchId: draftId,
      state: 'AK',
      batchRevision: draft.revision,
      order: ['AK.one', 'AK.three', 'AK.two'],
    })
  ).toMatchObject({ ok: true })

  const started = await POST(
    new Request('https://example.org/api/local-pipeline/runs', {
      method: 'POST',
      body: JSON.stringify({
        requestId: 'alabama',
        batchId: 'draft',
        plateIds: ['AL.one'],
        stages: ['tag'],
      }),
    })
  )
  expect(started.status).toBe(202)
  const { run } = await started.json()
  await dispatchQueueStage(deps, run.id, 1, 0, 'alabama-stage')
  const claimed = await (
    await claim(
      new Request('https://example.org/api/worker/claim', { method: 'POST' })
    )
  ).json()
  await reportResult(deps, 'worker', claimed.job.id, claimed.claimId, {
    suggestions: ['blue'],
    backend: 'fixture',
    model: 'test',
    promptVersion: 'v1',
    durationMs: 10,
  })
  // The run's Workflow settles the completed stage, which writes the result.
  expect(await observeQueueStage(deps, run.id, 1, 0)).toMatchObject({
    phase: 'done',
  })

  // Reload: a fresh read of the draft keeps the Alaska order and has the Alabama result.
  const reloaded = (await review.readBatch(draftId))!
  expect(reloaded.batch.stateOrders).toEqual({
    AK: ['AK.one', 'AK.three', 'AK.two'],
  })
  expect(
    reloaded.edits.find((edit) => edit.plateId === 'AL.one')?.fields.tags
  ).toEqual(['blue'])
  expect(
    draftPublishSummary(reloaded, await review.listChanges!(draftId, 0)).map(
      ({ state, plates, moved }) => ({ state, plates, moved })
    )
  ).toEqual([
    { state: 'AK', plates: 0, moved: 1 },
    { state: 'AL', plates: 1, moved: 0 },
  ])
})
