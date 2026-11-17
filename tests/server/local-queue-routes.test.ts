import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { localJobsEnvironment } from '../../lib/jobs/local-scope'
import { dispatchQueueStage, observeQueueStage } from '../../lib/jobs/queue-engine'
import { claimNext, getJob, reportResult } from '../../lib/jobs/jobs'
import type { JobsDeps } from '../../lib/jobs/types'
import { GET, POST } from '../../app/api/local-pipeline/runs/route'
import { POST as cancel } from '../../app/api/local-pipeline/runs/[id]/cancel/route'
import { POST as claim } from '../../app/api/worker/claim/route'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), jobs: vi.fn(), start: vi.fn(), resume: vi.fn() }))
vi.mock('../../lib/server/context', () => ({ currentActor: mocks.auth, jobsDeps: mocks.jobs, currentWorker: async () => ({ ok: true, workerId: 'worker' }), reviewDeps: () => ({}) }))
vi.mock('workflow/api', () => ({ start: mocks.start, resumeHook: mocks.resume }))
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
})
afterEach(() => vi.unstubAllEnvs())

test('authenticated enqueue starts installed Workflow once with an attempt token; reload restores stable run ID and summaries omit snapshots', async () => {
  expect((await POST(post())).status).toBe(202)
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
  expect(await (await GET(get())).json()).toEqual({ runs: [], orphanJobs: [] })
  expect((await cancel(new Request('https://example.org', { method: 'POST' }), { params: Promise.resolve({ id: run.id }) })).status).toBe(403)
  expect(await claimNext({ ...deps, localScope: undefined }, 'production')).toBeNull()
})
