import sharp from 'sharp'
import { createEnhanceImageRunner } from '../../worker/enhance-image'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { localJobsEnvironment } from '../../lib/jobs/local-scope'
import { dispatchQueueStage, observeQueueStage } from '../../lib/jobs/queue-engine'
import { claimNext, getJob, reportResult } from '../../lib/jobs/jobs'
import type { JobsDeps } from '../../lib/jobs/types'
import { GET, POST } from '../../app/api/local-pipeline/runs/route'
import { POST as createSelection } from '../../app/api/local-pipeline/runs/selection/route'
import { POST as cancel } from '../../app/api/local-pipeline/runs/[id]/cancel/route'
import { POST as claim } from '../../app/api/worker/claim/route'
import { POST as report } from '../../app/api/worker/jobs/[id]/report/route'
import { GET as getEnhancedImage } from '../../app/api/local-pipeline/jobs/[id]/enhanced-image/route'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), jobs: vi.fn(), start: vi.fn(), resume: vi.fn(), workflow: vi.fn() }))
vi.mock('../../lib/server/context', () => ({ currentActor: mocks.auth, jobsDeps: mocks.jobs, currentWorker: async () => ({ ok: true, workerId: 'worker' }), reviewDeps: () => ({}), catalog: () => ({ readSnapshot: async () => ({ version: 1 }) }) }))
vi.mock('../../lib/server/catalog-head', () => ({ catalogChanged: vi.fn() }))
vi.mock('workflow/api', () => ({ start: mocks.start, resumeHook: mocks.resume, getRun: mocks.workflow }))
const actor = { uid: 'editor', role: 'editor' as const, name: null }
const body = { requestId: 'request', batchId: 'batch', plateIds: ['AK.one'], stages: ['tag'] }
const post = () => new Request('https://example.org/api/local-pipeline/runs', { method: 'POST', body: JSON.stringify(body) })
const get = () => new Request('https://example.org/api/local-pipeline/runs')
let deps: JobsDeps

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const plate = { id: 'AK.one', state: 'AK', slug: 'one', displayName: 'One', image: '', tags: [] }
  const review = createMemoryStore([{ id: 'batch', name: 'Queue', createdBy: actor.uid, createdAt: '', revision: 0, state: 'open', baselineVersion: 1, plateIds: [plate.id], approval: null }])
  deps = { store: createMemoryJobsStore(review, localJobsEnvironment('route-test')), localScope: 'route-test', baseline: async () => plate,
    now: () => 100, id: () => 'claim', leaseMs: 1000 }
  mocks.auth.mockReset().mockResolvedValue({ ok: true, actor })
  mocks.jobs.mockReset().mockReturnValue(deps)
  mocks.start.mockReset().mockResolvedValue({ runId: 'workflow' })
  mocks.resume.mockReset().mockResolvedValue(undefined)
  mocks.workflow.mockReset().mockReturnValue({ status: Promise.resolve('running') })
})
afterEach(() => vi.unstubAllEnvs())

test('authenticated enqueue starts installed Workflow once with an attempt token; reload restores stable run ID and summaries omit snapshots', async () => {
  const added = await POST(post())
  expect(added.status).toBe(202)
  expect(await added.json()).toMatchObject({ run: { incrementalDrafts: true } })
  expect((await POST(post())).status).toBe(202)
  expect(mocks.start).toHaveBeenCalledTimes(1)
  expect(mocks.start.mock.calls[0][2].experimental_hook.token).toMatch(/^local-pipeline-start:route-test:/)
  const restored = await (await GET(get())).json()
  expect(restored.runs).toHaveLength(1)
  expect(restored.runs[0].attempts[0]).not.toHaveProperty('projection')
  expect(restored.runs[0].attempts[0]).not.toHaveProperty('steps')
  expect(restored.runs[0].attempts[0]).toMatchObject({ stepCount: 1, completedCount: 0 })
  expect(restored.selected.attempts[0].projection).toBeTruthy()
  expect(restored.selected.id).toBe(restored.runs[0].id)
  expect(restored.runs[0].progress).toMatchObject({ steps: [{ stage: 'tag', status: 'queued', plateName: 'One' }], workerIds: [] })
  expect(restored.runs[0].progress.steps[0]).not.toHaveProperty('inputPlate')
})

test('enqueue acknowledgement loss/start failure recovers the same persisted run on retry or GET', async () => {
  mocks.start.mockRejectedValueOnce(new Error('Temporary start failure'))
  expect((await POST(post())).status).toBe(503)
  expect((await deps.store.transaction(tx => tx.runs()))).toHaveLength(1)
  const result = await (await GET(get())).json()
  expect(result.runs).toHaveLength(1)
  expect((await deps.store.transaction(tx => tx.runs()))[0].attempts[0].workflowId).toBe('workflow')
})

test('claim callback wakes the persisted lease; lost completed callback is reconciled by GET without creating another stage job', async () => {
  await POST(post())
  const [run] = await deps.store.transaction(tx => tx.runs())
  const token = 'local-pipeline-stage'
  await dispatchQueueStage(deps, run.id, 1, 0, token)
  const response = await claim(new Request('https://example.org/api/worker/claim', { method: 'POST' }))
  expect(response.status).toBe(200)
  const claimed = await response.json()
  expect(mocks.resume).toHaveBeenCalledWith(token, { jobId: claimed.job.id })
  expect(await observeQueueStage(deps, run.id, 1, 0)).toMatchObject({ phase: 'claimed', deadline: 600100 })
  await reportResult(deps, 'worker', claimed.job.id, claimed.claimId, { suggestions: ['blue'], backend: 'fixture', model: 'test', promptVersion: 'v1', durationMs: 10 })
  mocks.resume.mockImplementation(async () => expect((await getJob(deps, claimed.job.id))?.state).toBe('completed'))
  await GET(get())
  expect(mocks.resume).toHaveBeenLastCalledWith(token, { jobId: claimed.job.id })
  expect(await deps.store.transaction(tx => tx.list())).toHaveLength(1)
})

test('authentication and other-owner visibility/mutations reject without exposing runs', async () => {
  mocks.auth.mockResolvedValueOnce({ ok: false, response: Response.json({ error: 'unauthenticated' }, { status: 401 }) })
  expect((await POST(post())).status).toBe(401)
  expect(mocks.jobs).not.toHaveBeenCalled()
  await POST(post())
  const [run] = await deps.store.transaction(tx => tx.runs())
  mocks.auth.mockResolvedValue({ ok: true, actor: { ...actor, uid: 'other' } })
  expect(await (await GET(get())).json()).toMatchObject({ runs: [], orphanJobs: [], observedAt: 100, capabilities: { previewOnly: { available: true } } })
  expect((await cancel(new Request('https://example.org', { method: 'POST' }), { params: Promise.resolve({ id: run.id }) })).status).toBe(403)
  expect(await claimNext({ ...deps, localScope: undefined }, 'production')).toBeNull()
})

test('GET records an actual exhausted Workflow failure as retryable failure when no physical stage is active', async () => {
  await POST(post())
  mocks.workflow.mockReturnValue({ status: Promise.resolve('failed') })
  const restored = await (await GET(get())).json()
  expect(restored.runs[0]).toMatchObject({ status: 'failed', attempts: [{ error: 'workflow_failed' }] })
  expect(mocks.start).toHaveBeenCalledTimes(1)
})

test('a named selection creates and starts one new draft instead of using the existing Batch', async () => {
  const request = () => new Request('https://example.org/api/local-pipeline/runs/selection', { method: 'POST',
    body: JSON.stringify({ requestId: body.requestId, plateIds: body.plateIds, stages: body.stages, batchName: 'New Alaska draft' }) })
  const initial = await createSelection(request())
  expect(initial.status).toBe(202)
  const value = await initial.json()
  expect(value.batchId).not.toBe('batch')
  expect(value).toMatchObject({ run: { incrementalDrafts: true, batchId: value.batchId }, runIds: [value.run.id] })
  expect(await deps.store.transaction(tx => tx.batch(value.batchId))).toMatchObject({ name: 'New Alaska draft', plateIds: body.plateIds })
  expect(await (await createSelection(request())).json()).toMatchObject({ batchId: value.batchId, runIds: value.runIds })
  expect(mocks.start).toHaveBeenCalledTimes(1)
})


test('enhancement options reach the capable worker and the completed WebP is private to the run', async () => {
  const options = { 'enhance-image': { upscale: false, crop: false, roundCorners: true } }
  const payload = { ...body, stages: ['enhance-image'], options }
  const request = (value: object) => new Request('https://example.org', { method: 'POST', body: JSON.stringify(value) })
  expect((await POST(request({ ...payload, options: { 'enhance-image': { ...options['enhance-image'], roundCorners: false } } }))).status).toBe(400)
  expect((await POST(request(payload))).status).toBe(202)
  const [run] = await deps.store.transaction(tx => tx.runs())
  await dispatchQueueStage(deps, run.id, 1, 0, 'worker-stage')
  expect((await claim(request({}))).status).toBe(204)
  const available = { available: true }
  const capabilities = { group: available, embeddings: available, mask: available, vision: available, enhanceImage: available, pollIntervalMs: 1000 }
  const claimed = await (await claim(request({ capabilities }))).json()
  expect(claimed).toMatchObject({ stage: 'enhance-image', stageOptions: options['enhance-image'] })
  const input = await sharp({ create: { width: 160, height: 80, channels: 3, background: 'red' } }).png().toBuffer()
  const result = await createEnhanceImageRunner(async () => input.toString('base64'))({
    stage: claimed.stage, plate: { ...claimed.plate, image: 'AK/one.webp' }, options: claimed.stageOptions,
  })
  const route = { params: Promise.resolve({ id: claimed.job.id }) }
  expect((await report(request({ ...result, claimId: claimed.claimId, durationMs: 10 }), route)).status).toBe(200)
  expect(await observeQueueStage(deps, run.id, 1, 0)).toEqual({ phase: 'done' })
  const response = await getEnhancedImage(get(), route)
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  expect(await response.json()).toEqual({ image: result.enhancedImage })
  mocks.auth.mockResolvedValue({ ok: true, actor: { ...actor, uid: 'other' } })
  expect((await getEnhancedImage(get(), route)).status).toBe(404)
})
