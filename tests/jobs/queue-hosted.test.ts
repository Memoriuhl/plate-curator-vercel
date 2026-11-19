import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMemoryStore } from '../../lib/review/memory-store'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import {
  cancelRun,
  enqueueRun,
  enqueueSelection,
  listRuns,
  retryRun,
} from '../../lib/jobs/queue'
import {
  dispatchGatewayTagWave,
  dispatchQueueStage,
  observeQueueStage,
} from '../../lib/jobs/queue-engine'
import { claimNext, getJob, reportResult } from '../../lib/jobs/jobs'
import { tagHostedJob, type HostedDeps } from '../../lib/jobs/hosted'
import { applyQueueBundle } from '../../lib/jobs/queue-bundle'
import { executeHostedQueueStage } from '../../lib/jobs/queue-hosted'
import type { JobsDeps } from '../../lib/jobs/types'

const actor = { uid: 'editor', role: 'editor' as const, name: null }
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  vi.stubEnv('TAGGING_MODELS', 'desktop-gemma4-12b,gateway-gemma4-26b')
})
afterEach(() => vi.unstubAllEnvs())

/** Create a hosted queue fixture and expose the model spy used to count inferences. */
function setup(slugs = ['one']) {
  const plates = slugs.map((slug) => ({
    id: `AK.${slug}`,
    state: 'AK',
    slug,
    displayName: slug,
    image: 'one.webp',
    tags: [] as string[],
  }))
  const review = createMemoryStore([
    {
      id: 'batch',
      name: 'Hosted queue',
      createdBy: actor.uid,
      createdAt: '',
      revision: 0,
      state: 'open',
      baselineVersion: 1,
      plateIds: plates.map((plate) => plate.id),
      approval: null,
    },
  ])
  let sequence = 0
  const jobs: JobsDeps = {
    store: createMemoryJobsStore(review, 'preview:local-pipeline-hosted'),
    localScope: 'hosted',
    /** Supply the requested test plate as the catalog baseline. */
    baseline: async (id) => plates.find((plate) => plate.id === id) ?? null,
    /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () =>
      100,
    /** Issue deterministic IDs in allocation order so the test can address each generated record. */ id: () =>
      `claim-${++sequence}`,
    leaseMs: 1000,
  }
  const suggest = vi.fn<HostedDeps['adapter']['suggest']>(async () => ({
    tags: ['blue'],
    usage: { tokens: 12 },
  }))
  const hosted: HostedDeps = {
    jobs,
    adapter: {
      backend: 'hosted',
      model: 'google/gemma-4-26b-a4b-it',
      promptVersion: 'fixture',
      suggest,
    },
    /** Read the queued plate from the job's pinned execution input. */
    plate: async (job) => job.inputPlate!,
    /** Provide a stable image payload to the hosted model double. */ image:
      async () => 'fixture-image',
  }
  return { jobs, review, hosted, suggest, plates }
}

test.each([false, true])(
  'hosted Tag consumes projected Colors, survives reload and respects explicit Apply / Preview %s',
  async (previewOnly) => {
    const s = setup()
    const created = await enqueueRun(s.jobs, actor, {
      requestId: 'hosted',
      batchId: 'batch',
      plateIds: ['AK.one'],
      stages: ['colors', 'tag'],
      modelId: 'desktop-gemma4-12b',
      tagModelId: 'gateway-gemma4-26b',
      previewOnly,
    })
    expect(created).toMatchObject({
      ok: true,
      value: { tagModelId: 'gateway-gemma4-26b' },
    })
    if (!created.ok) throw Error(created.error)
    const run = created.value
    await dispatchQueueStage(s.jobs, run.id, 1, 0, 'colors')
    const colors = (await claimNext(s.jobs, 'desktop'))!
    await reportResult(s.jobs, 'desktop', colors.job.id, colors.claimId, {
      backend: 'fixture',
      model: 'gemma4:12b',
      promptVersion: 'fixture',
      durationMs: 1,
      fieldSuggestion: {
        kind: 'fields',
        stage: 'colors',
        fields: { colorDetail: 'Blue text on white' },
        sources: [],
      },
    })
    await observeQueueStage(s.jobs, run.id, 1, 0)
    const id = (await dispatchQueueStage(
      { ...s.jobs },
      run.id,
      1,
      1,
      'hosted'
    ))!
    expect(await getJob(s.jobs, id)).toMatchObject({
      route: 'hosted',
      modelId: 'gateway-gemma4-26b',
      inputPlate: { colorDetail: 'Blue text on white' },
    })
    expect(await claimNext(s.jobs, 'desktop')).toBeNull()
    expect(
      await executeHostedQueueStage(s.jobs, id, async () => s.hosted)
    ).toBe('settled')
    expect(s.suggest).toHaveBeenCalledOnce()
    expect(await tagHostedJob(s.hosted, id)).toEqual({ outcome: 'completed' })
    expect(s.suggest).toHaveBeenCalledOnce()
    await observeQueueStage(s.jobs, run.id, 1, 1)
    expect(await listRuns({ ...s.jobs }, actor)).toMatchObject({
      value: [
        {
          status: 'completed',
          jobs: expect.arrayContaining([
            expect.objectContaining({
              modelId: 'gateway-gemma4-26b',
              result: {
                suggestions: ['blue'],
                backend: 'hosted',
                model: 'google/gemma-4-26b-a4b-it',
                promptVersion: 'fixture',
                durationMs: 0,
                usage: { tokens: 12 },
              },
            }),
          ]),
        },
      ],
    })
    expect(await s.review.listEdits('batch')).toEqual([])
    const applied = await applyQueueBundle(
      s.jobs,
      {
        store: s.review,
        baseline: s.jobs.baseline,
        /** Resolve the plate by ID from the fixture baseline. */ baselineAtVersion:
          async (_, id) => s.jobs.baseline(id),
        /** Simulate a state with no available baseline plates. */ stateBaseline:
          async () => [],
        /** Use an empty timestamp where the scenario does not depend on dates. */ now: () =>
          '',
      },
      actor,
      run.id
    )
    expect(applied).toMatchObject(
      previewOnly ? { error: 'forbidden' } : { ok: true }
    )
    if (!previewOnly)
      expect((await s.review.getEdit('batch', 'AK.one'))?.fields).toMatchObject(
        { tags: ['blue'], colorDetail: 'Blue text on white' }
      )
  }
)

test('hosted dispatch shares two IO reservations, leaves GPU free, and retries keep the resolved model', async () => {
  const s = setup()
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  s.suggest.mockImplementation(async () => {
    await barrier
    return { tags: ['blue'], usage: { tokens: 12 } }
  })
  const ids: string[] = []
  const runs = []
  for (let index = 0; index < 3; index++) {
    const requester =
      index < 2
        ? { ...actor, uid: `owner-${index}`, role: 'owner' as const }
        : actor
    const run = await enqueueRun(s.jobs, requester, {
      requestId: `run-${index}`,
      batchId: 'batch',
      plateIds: ['AK.one'],
      stages: ['tag'],
      modelId: 'gateway-gemma4-26b',
    })
    if (!run.ok) throw Error(run.error)
    runs.push(run.value)
    ids.push(
      (await dispatchQueueStage(s.jobs, run.value.id, 1, 0, `hook-${index}`))!
    )
  }
  const first = executeHostedQueueStage(s.jobs, ids[0], async () => s.hosted)
  await vi.waitFor(() => expect(s.suggest).toHaveBeenCalledTimes(1))
  const second = executeHostedQueueStage(s.jobs, ids[1], async () => s.hosted)
  await vi.waitFor(() => expect(s.suggest).toHaveBeenCalledTimes(2))
  expect(
    await executeHostedQueueStage(s.jobs, ids[2], async () => s.hosted)
  ).toBe('waiting')
  const desktop = await enqueueRun(
    s.jobs,
    { ...actor, uid: 'owner-desktop', role: 'owner' },
    {
      requestId: 'desktop',
      batchId: 'batch',
      plateIds: ['AK.one'],
      stages: ['tag'],
      modelId: 'desktop-gemma4-12b',
    }
  )
  if (!desktop.ok) throw Error(desktop.error)
  await dispatchQueueStage(s.jobs, desktop.value.id, 1, 0, 'desktop')
  expect((await claimNext(s.jobs, 'desktop'))?.job.queueRunId).toBe(
    desktop.value.id
  )
  release()
  await Promise.all([first, second])
  await cancelRun(s.jobs, actor, runs[2].id)
  expect(
    await executeHostedQueueStage(s.jobs, ids[2], async () => s.hosted)
  ).toBe('settled')
  vi.stubEnv('TAGGING_MODELS', 'desktop-gemma4-12b')
  expect(await retryRun(s.jobs, actor, runs[2].id, 'retry')).toMatchObject({
    value: { tagModelId: 'gateway-gemma4-26b' },
  })
  const retryId = (await dispatchQueueStage(
    s.jobs,
    runs[2].id,
    2,
    0,
    'retry-hook'
  ))!
  expect(await getJob(s.jobs, retryId)).toMatchObject({
    route: 'hosted',
    modelId: 'gateway-gemma4-26b',
  })
  expect(await s.review.listEdits('batch')).toEqual([])
})

test('a disabled hosted model is rejected at enqueue and hosted failure never edits saved fields', async () => {
  const s = setup()
  vi.stubEnv('TAGGING_MODELS', 'desktop-gemma4-12b')
  const input = {
    requestId: 'bad',
    batchId: 'batch',
    plateIds: ['AK.one'],
    stages: ['tag'] as ['tag'],
    tagModelId: 'gateway-gemma4-26b',
  }
  expect(await enqueueRun(s.jobs, actor, input)).toMatchObject({
    error: 'invalid_state',
  })
  vi.stubEnv('TAGGING_MODELS', 'gateway-gemma4-26b')
  const run = await enqueueRun(s.jobs, actor, input)
  if (!run.ok) throw Error(run.error)
  const id = (await dispatchQueueStage(s.jobs, run.value.id, 1, 0, 'failure'))!
  s.suggest.mockRejectedValue(
    Object.assign(Error('Invalid request'), { status: 400 })
  )
  expect(await executeHostedQueueStage(s.jobs, id, async () => s.hosted)).toBe(
    'settled'
  )
  await observeQueueStage(s.jobs, run.value.id, 1, 0)
  expect(await listRuns(s.jobs, actor)).toMatchObject({
    value: [{ status: 'failed' }],
  })
  expect(await s.review.listEdits('batch')).toEqual([])
})

test('a 23-plate Gateway Tag run and a later run together issue at most six model calls concurrently', async () => {
  const s = setup(Array.from({ length: 24 }, (_, i) => `plate-${i}`))
  const result = await enqueueSelection(s.jobs, actor, {
    requestId: 'gateway-23',
    batchId: 'batch',
    plateIds: s.plates.slice(0, 23).map((plate) => plate.id),
    stages: ['tag'],
    tagModelId: 'gateway-gemma4-26b',
  })
  if (!result.ok) throw Error(result.error)
  const [run] = result.value
  const later = await enqueueRun(s.jobs, actor, {
    requestId: 'next-tag',
    batchId: 'batch',
    plateIds: [s.plates[23].id],
    stages: ['tag'],
    tagModelId: 'gateway-gemma4-26b',
  })
  if (!later.ok) throw Error(later.error)
  const laterJob = (await dispatchQueueStage(
    s.jobs,
    later.value.id,
    1,
    0,
    'later'
  ))!
  let peak = 0
  let cursor = 0
  let rounds = 0
  while (cursor < 23) {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let inFlight = 0
    s.suggest.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight)
      await barrier
      inFlight--
      return { tags: ['blue'], usage: { tokens: 12 } }
    })
    const jobs = []
    for (let i = cursor; i < Math.min(cursor + 6, 23); i++) {
      jobs.push((await dispatchQueueStage(s.jobs, run.id, 1, i, `phase-${i}`))!)
    }
    expect(jobs.every(Boolean)).toBe(true)
    expect(
      await dispatchQueueStage(s.jobs, run.id, 1, cursor + 6, 'beyond-window')
    ).toBeNull()
    // The later run does not wait for this one: it shares the Gateway slots from the
    // first round.
    const offered = rounds === 0 ? [...jobs, laterJob] : jobs
    const parallel = offered.map((jobId) =>
      executeHostedQueueStage(s.jobs, jobId, async () => s.hosted)
    )
    try {
      await vi.waitFor(() => expect(inFlight).toBe(Math.min(6, offered.length)))
    } finally {
      release()
    }
    const outcomes = await Promise.all(parallel)
    if (rounds === 0)
      expect(outcomes).toEqual([
        ...jobs.slice(0, 5).map(() => 'settled'),
        'waiting',
        'settled',
      ])
    else expect(outcomes).toEqual(jobs.map(() => 'settled'))
    const settled = jobs.filter((_, offset) => outcomes[offset] === 'settled')
    for (const [offset, jobId] of settled.entries()) {
      expect(await getJob(s.jobs, jobId)).toMatchObject({ state: 'completed' })
      expect(
        await observeQueueStage(s.jobs, run.id, 1, cursor + offset)
      ).toMatchObject({ phase: cursor + offset === 22 ? 'done' : 'next' })
    }
    cursor += settled.length
    rounds++
  }
  expect(rounds).toBe(4)
  expect(peak).toBe(6)
  expect(s.suggest).toHaveBeenCalledTimes(24)
  expect(await s.review.listEdits('batch')).toHaveLength(23)
  expect(await listRuns(s.jobs, actor)).toMatchObject({
    value: expect.arrayContaining([
      expect.objectContaining({
        id: run.id,
        status: 'completed',
        attempts: [expect.objectContaining({ cursor: 23 })],
      }),
    ]),
  })
  expect(await getJob(s.jobs, laterJob)).toMatchObject({ state: 'completed' })
})

test('cancel stops unsent Gateway Tag requests and keeps the already running results', async () => {
  const s = setup(['one', 'two', 'three', 'four'])
  const result = await enqueueSelection(s.jobs, actor, {
    requestId: 'cancel-tags',
    batchId: 'batch',
    plateIds: s.plates.map((plate) => plate.id),
    stages: ['tag'],
    tagModelId: 'gateway-gemma4-26b',
  })
  if (!result.ok) throw Error(result.error)
  const [run] = result.value
  const jobs = []
  for (let i = 0; i < 4; i++)
    jobs.push((await dispatchQueueStage(s.jobs, run.id, 1, i, `cancel-${i}`))!)
  expect(jobs.every(Boolean)).toBe(true)
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  s.suggest.mockImplementation(async () => {
    await barrier
    return { tags: ['blue'], usage: { tokens: 12 } }
  })
  const running = jobs
    .slice(0, 2)
    .map((job) => executeHostedQueueStage(s.jobs, job, async () => s.hosted))
  try {
    await vi.waitFor(() => expect(s.suggest).toHaveBeenCalledTimes(2))
    expect(await cancelRun(s.jobs, actor, run.id)).toMatchObject({
      ok: true,
      value: { status: 'running' },
    })
    expect(await getJob(s.jobs, jobs[2])).toMatchObject({ state: 'cancelled' })
    expect(await getJob(s.jobs, jobs[3])).toMatchObject({ state: 'cancelled' })
  } finally {
    release()
  }
  await Promise.all(running)
  for (let i = 0; i < 4; i++) await observeQueueStage(s.jobs, run.id, 1, i)
  expect(s.suggest).toHaveBeenCalledTimes(2)
  expect(await s.review.listEdits('batch')).toHaveLength(2)
  expect(await listRuns(s.jobs, actor)).toMatchObject({
    value: [{ id: run.id, status: 'cancelled' }],
  })
})

test('retrying a partial Gateway Tag run sends only the failed plate again', async () => {
  const s = setup(['one', 'two', 'three'])
  const created = await enqueueSelection(s.jobs, actor, {
    requestId: 'partial-tags',
    batchId: 'batch',
    plateIds: s.plates.map((plate) => plate.id),
    stages: ['tag'],
    tagModelId: 'gateway-gemma4-26b',
  })
  if (!created.ok) throw Error(created.error)
  const [run] = created.value
  s.suggest.mockImplementation(async ({ plate }) => {
    if (plate.displayName === 'two')
      throw Object.assign(new Error('Invalid input'), { status: 400 })
    return { tags: ['blue'], usage: { tokens: 12 } }
  })
  const first = await dispatchGatewayTagWave(s.jobs, run.id, 1, 0)
  await Promise.all(
    first.map(({ id }) =>
      executeHostedQueueStage(s.jobs, id, async () => s.hosted)
    )
  )
  for (const { index } of first)
    await observeQueueStage(s.jobs, run.id, 1, index)
  expect(await s.review.listEdits('batch')).toHaveLength(2)

  const retry = await retryRun(s.jobs, actor, run.id, 'retry-only-two')
  if (!retry.ok) throw Error(retry.error)
  const remaining = await dispatchGatewayTagWave(
    s.jobs,
    run.id,
    2,
    retry.value.attempts[1].cursor
  )
  expect(remaining.map(({ index }) => index)).toEqual([1])
  s.suggest.mockResolvedValue({ tags: ['blue'], usage: { tokens: 12 } })
  await executeHostedQueueStage(s.jobs, remaining[0].id, async () => s.hosted)
  await observeQueueStage(s.jobs, run.id, 2, remaining[0].index)
  expect(s.suggest).toHaveBeenCalledTimes(4)
  expect(await s.review.listEdits('batch')).toHaveLength(3)
})
