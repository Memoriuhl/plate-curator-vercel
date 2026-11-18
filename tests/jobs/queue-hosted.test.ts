import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMemoryStore } from '../../lib/review/memory-store'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { cancelRun, enqueueRun, listRuns, retryRun } from '../../lib/jobs/queue'
import { dispatchQueueStage, observeQueueStage } from '../../lib/jobs/queue-engine'
import { claimNext, getJob, reportResult } from '../../lib/jobs/jobs'
import { tagHostedJob, type HostedDeps } from '../../lib/jobs/hosted'
import { applyQueueBundle } from '../../lib/jobs/queue-bundle'
import { executeHostedQueueStage } from '../../lib/jobs/queue-hosted'
import type { JobsDeps } from '../../lib/jobs/types'

const actor = { uid: 'editor', role: 'editor' as const, name: null }
beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1'); vi.stubEnv('TAGGING_MODELS', 'desktop-gemma4-12b,gateway-gemma4-26b') })
afterEach(() => vi.unstubAllEnvs())

function setup() {
  const plate = { id: 'AK.one', state: 'AK', slug: 'one', displayName: 'One', image: 'one.webp', tags: [] }
  const review = createMemoryStore([{ id: 'batch', name: 'Hosted queue', createdBy: actor.uid, createdAt: '', revision: 0, state: 'open', baselineVersion: 1, plateIds: [plate.id], approval: null }])
  let sequence = 0
  const jobs: JobsDeps = { store: createMemoryJobsStore(review, 'preview:local-pipeline-hosted'), localScope: 'hosted',
    baseline: async () => plate, now: () => 100, id: () => `claim-${++sequence}`, leaseMs: 1000 }
  const suggest = vi.fn(async () => ({ tags: ['blue'], usage: { tokens: 12 } }))
  const hosted: HostedDeps = { jobs, adapter: { backend: 'hosted', model: 'google/gemma-4-26b-a4b-it', promptVersion: 'fixture', suggest },
    plate: async job => job.inputPlate!, image: async () => 'fixture-image' }
  return { jobs, review, hosted, suggest }
}

test.each([false, true])('hosted Tag consumes projected Colors, survives reload and respects explicit Apply / Preview %s', async previewOnly => {
  const s = setup()
  const created = await enqueueRun(s.jobs, actor, { requestId: 'hosted', batchId: 'batch', plateIds: ['AK.one'], stages: ['colors', 'tag'],
    modelId: 'desktop-gemma4-12b', tagModelId: 'gateway-gemma4-26b', previewOnly })
  expect(created).toMatchObject({ ok: true, value: { tagModelId: 'gateway-gemma4-26b' } })
  if (!created.ok) throw Error(created.error)
  const run = created.value
  await dispatchQueueStage(s.jobs, run.id, 1, 0, 'colors')
  const colors = (await claimNext(s.jobs, 'desktop'))!
  await reportResult(s.jobs, 'desktop', colors.job.id, colors.claimId, { backend: 'fixture', model: 'gemma4:12b', promptVersion: 'fixture', durationMs: 1,
    fieldSuggestion: { kind: 'fields', stage: 'colors', fields: { colorDetail: 'Blue text on white' }, sources: [] } })
  await observeQueueStage(s.jobs, run.id, 1, 0)
  const id = (await dispatchQueueStage({ ...s.jobs }, run.id, 1, 1, 'hosted'))!
  expect(await getJob(s.jobs, id)).toMatchObject({ route: 'hosted', modelId: 'gateway-gemma4-26b', inputPlate: { colorDetail: 'Blue text on white' } })
  expect(await claimNext(s.jobs, 'desktop')).toBeNull()
  expect(await executeHostedQueueStage(s.jobs, id, async () => s.hosted)).toBe('settled')
  expect(s.suggest).toHaveBeenCalledOnce()
  expect(await tagHostedJob(s.hosted, id)).toEqual({ outcome: 'completed' })
  expect(s.suggest).toHaveBeenCalledOnce()
  await observeQueueStage(s.jobs, run.id, 1, 1)
  expect(await listRuns({ ...s.jobs }, actor)).toMatchObject({ value: [{ status: 'completed', jobs: expect.arrayContaining([expect.objectContaining({ modelId: 'gateway-gemma4-26b', result: { suggestions: ['blue'], backend: 'hosted', model: 'google/gemma-4-26b-a4b-it', promptVersion: 'fixture', durationMs: 0, usage: { tokens: 12 } } })]) }] })
  expect(await s.review.listEdits('batch')).toEqual([])
  const applied = await applyQueueBundle(s.jobs, { store: s.review, baseline: s.jobs.baseline, baselineAtVersion: async (_, id) => s.jobs.baseline(id), stateBaseline: async () => [], now: () => '' }, actor, run.id)
  expect(applied).toMatchObject(previewOnly ? { error: 'forbidden' } : { ok: true })
  if (!previewOnly) expect((await s.review.getEdit('batch', 'AK.one'))?.fields).toMatchObject({ tags: ['blue'], colorDetail: 'Blue text on white' })
})

test('hosted dispatch shares two IO reservations, leaves GPU free, and retries keep the resolved model', async () => {
  const s = setup()
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  s.suggest.mockImplementation(async () => { await barrier; return { tags: ['blue'], usage: { tokens: 12 } } })
  const ids: string[] = []
  const runs = []
  for (let index = 0; index < 3; index++) {
    const run = await enqueueRun(s.jobs, actor, { requestId: `run-${index}`, batchId: 'batch', plateIds: ['AK.one'], stages: ['tag'], modelId: 'gateway-gemma4-26b' })
    if (!run.ok) throw Error(run.error)
    runs.push(run.value)
    ids.push((await dispatchQueueStage(s.jobs, run.value.id, 1, 0, `hook-${index}`))!)
  }
  const first = executeHostedQueueStage(s.jobs, ids[0], async () => s.hosted)
  await vi.waitFor(() => expect(s.suggest).toHaveBeenCalledTimes(1))
  const second = executeHostedQueueStage(s.jobs, ids[1], async () => s.hosted)
  await vi.waitFor(() => expect(s.suggest).toHaveBeenCalledTimes(2))
  expect(await executeHostedQueueStage(s.jobs, ids[2], async () => s.hosted)).toBe('waiting')
  const desktop = await enqueueRun(s.jobs, actor, { requestId: 'desktop', batchId: 'batch', plateIds: ['AK.one'], stages: ['tag'], modelId: 'desktop-gemma4-12b' })
  if (!desktop.ok) throw Error(desktop.error)
  await dispatchQueueStage(s.jobs, desktop.value.id, 1, 0, 'desktop')
  expect((await claimNext(s.jobs, 'desktop'))?.job.queueRunId).toBe(desktop.value.id)
  release(); await Promise.all([first, second])
  await cancelRun(s.jobs, actor, runs[2].id)
  expect(await executeHostedQueueStage(s.jobs, ids[2], async () => s.hosted)).toBe('settled')
  vi.stubEnv('TAGGING_MODELS', 'desktop-gemma4-12b')
  expect(await retryRun(s.jobs, actor, runs[2].id, 'retry')).toMatchObject({ value: { tagModelId: 'gateway-gemma4-26b' } })
  const retryId = (await dispatchQueueStage(s.jobs, runs[2].id, 2, 0, 'retry-hook'))!
  expect(await getJob(s.jobs, retryId)).toMatchObject({ route: 'hosted', modelId: 'gateway-gemma4-26b' })
  expect(await s.review.listEdits('batch')).toEqual([])
})

test('a disabled hosted model is rejected at enqueue and hosted failure never edits saved fields', async () => {
  const s = setup()
  vi.stubEnv('TAGGING_MODELS', 'desktop-gemma4-12b')
  const input = { requestId: 'bad', batchId: 'batch', plateIds: ['AK.one'], stages: ['tag'] as ['tag'], tagModelId: 'gateway-gemma4-26b' }
  expect(await enqueueRun(s.jobs, actor, input)).toMatchObject({ error: 'invalid_state' })
  vi.stubEnv('TAGGING_MODELS', 'gateway-gemma4-26b')
  const run = await enqueueRun(s.jobs, actor, input)
  if (!run.ok) throw Error(run.error)
  const id = (await dispatchQueueStage(s.jobs, run.value.id, 1, 0, 'failure'))!
  s.suggest.mockRejectedValue(Object.assign(Error('Invalid request'), { status: 400 }))
  expect(await executeHostedQueueStage(s.jobs, id, async () => s.hosted)).toBe('settled')
  await observeQueueStage(s.jobs, run.value.id, 1, 0)
  expect(await listRuns(s.jobs, actor)).toMatchObject({ value: [{ status: 'failed' }] })
  expect(await s.review.listEdits('batch')).toEqual([])
})
