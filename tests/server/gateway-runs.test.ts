import { beforeEach, expect, test, vi } from 'vitest'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { listGatewayRuns } from '../../lib/jobs/gateway-runs'
import type { JobsDeps, TaggingJob } from '../../lib/jobs/types'
import { GET } from '../../app/api/jobs/runs/route'

const mocks = vi.hoisted(() => ({ connection: vi.fn(), auth: vi.fn(), jobs: vi.fn() }))
vi.mock('next/server', () => ({ connection: mocks.connection }))
vi.mock('../../lib/server/context', () => ({ currentActor: mocks.auth, jobsDeps: mocks.jobs }))
const actor = { uid: 'editor', role: 'editor' as const, name: null }
let deps: JobsDeps
beforeEach(async () => {
  mocks.connection.mockReset().mockResolvedValue(undefined)
  deps = { store: createMemoryJobsStore(createMemoryStore([]), 'development'), baseline: async () => null, now: () => 400, id: () => 'id', leaseMs: 1000 }
  mocks.auth.mockReset().mockResolvedValue({ ok: true, actor })
  mocks.jobs.mockReset().mockReturnValue(deps)
  await deps.store.transaction(async tx => {
    const base: TaggingJob = { id: 'one', batchId: 'batch', plateId: 'AK.one', inputHash: 'hash', requestedBy: actor.uid, route: 'hosted', env: 'development', state: 'completed', createdAt: 100, completedAt: 300, workflowId: 'wrun_one', workflowUrl: 'https://vercel.com/memoriuhl/plate-curator-vercel/workflows/runs/wrun_one?environment=preview', modelId: 'gateway-gemma4-26b', completionHook: 'private-hook', result: { suggestions: ['blue'], durationMs: 200, model: 'gemma', backend: 'gateway', promptVersion: 'v1' } }
    tx.create(base)
    tx.create({ ...base, id: 'two', plateId: 'AK.two', state: 'claimed', completedAt: undefined, result: undefined })
    tx.create({ ...base, id: 'someone-else', workflowId: 'wrun_other', requestedBy: 'other' })
    tx.create({ ...base, id: 'local', workflowId: 'local', route: 'local' })
    tx.create({ ...base, id: 'different-scope', workflowId: 'different', localScope: 'other' })
  })
})
test('only authorized hosted jobs in this scope are returned, grouped by actual Workflow identity', async () => {
  const runs = await listGatewayRuns(deps, actor)
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ id: 'wrun_one', status: 'running', plateIds: ['AK.one', 'AK.two'] })
  expect(runs[0].progress.endedAt).toBeUndefined()
  expect(runs[0].results).toMatchObject([{ suggestions: ['blue'] }])
  expect(JSON.stringify(runs)).not.toContain('private-hook')
  expect(await listGatewayRuns(deps, { ...actor, role: 'owner' })).toHaveLength(2)
})
test('history waits for a live request before reading Firebase configuration', async () => {
  mocks.connection.mockRejectedValueOnce(new Error('Prerender has no request'))
  await expect(GET(new Request('https://example.org/api/jobs/runs'))).rejects.toThrow('Prerender has no request')
  expect(mocks.auth).not.toHaveBeenCalled()
})

test('history endpoint rejects unauthenticated access before reading storage', async () => {
  mocks.auth.mockResolvedValueOnce({ ok: false, response: Response.json({ error: 'unauthenticated' }, { status: 401 }) })
  expect((await GET(new Request('https://example.org/api/jobs/runs'))).status).toBe(401)
  expect(mocks.jobs).not.toHaveBeenCalled()
})
test('history restores saved results and the exact Workflow Visibility URL', async () => {
  const result = await (await GET(new Request('https://example.org/api/jobs/runs'))).json()
  expect(result).toMatchObject({ observedAt: 400, runs: [{ id: 'wrun_one', progress: { workflowUrl: expect.stringContaining('/workflows/runs/wrun_one?environment=preview') } }] })
})

test('Gateway stages from one connected run use its review identity and count each Plate once', async () => {
  await deps.store.transaction(async tx => {
    const base = (await tx.get('one'))!
    tx.create({ ...base, id: 'research', queueRunId: 'connected-run', stage: 'research' })
    tx.create({ ...base, id: 'tag', queueRunId: 'connected-run', workflowId: 'separate-job-workflow' })
  })
  expect(await listGatewayRuns(deps, actor)).toContainEqual(expect.objectContaining({
    id: 'connected-run', stages: ['research', 'tag'], plateIds: ['AK.one'], status: 'completed',
  }))
})
