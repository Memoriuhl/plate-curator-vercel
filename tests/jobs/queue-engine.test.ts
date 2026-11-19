import sharp from 'sharp'
import { createEnhanceImageRunner } from '../../worker/enhance-image'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { localJobsEnvironment } from '../../lib/jobs/local-scope'
import {
  claimHostedQueueJob,
  claimJob,
  claimNext,
  createJob,
  expireJob,
  getJob,
  reportResult,
} from '../../lib/jobs/jobs'
import {
  enqueueRun,
  enqueueSelection,
  cancelRun,
  dismissRun,
  listRuns,
  retryRun,
  maxQueueAttempts,
} from '../../lib/jobs/queue'
import {
  bindQueueWorkflow,
  confirmStoppedWorker,
  dispatchGatewayTagWave,
  dispatchQueueStage,
  observeQueueStage,
  recordQueueWorkflowFailure,
} from '../../lib/jobs/queue-engine'
import {
  failLocalJob,
  listLocalOrphanJobs,
  recoverLocalOrphanJob,
} from '../../lib/jobs/queue-failure'
import {
  readLocalWorkerCapabilities,
  reportLocalWorkerCapabilities,
} from '../../lib/jobs/capabilities'
import type { JobsDeps, ReportInput } from '../../lib/jobs/types'
import type { Actor } from '../../lib/review/types'
import type { LocalRunStage } from '../../lib/jobs/queue-types'
import { useModelCatalogFixture } from '../models/fixture'

useModelCatalogFixture()

const actor = { uid: 'editor', role: 'editor' as const, name: null }
const other = { ...actor, uid: 'other' }
const owner = { ...actor, uid: 'owner', role: 'owner' as const }
const base = {
  backend: 'test',
  model: 'fixture',
  promptVersion: 'v1',
  durationMs: 10,
}

/**
 * Set up a scoped queue with a controlled clock, review store and deterministic job
 * claims.
 */
function setup(slugs = ['one', 'two']) {
  let time = 100,
    sequence = 0
  const plates = slugs.map((slug) => ({
    id: `AK.${slug}`,
    state: 'AK',
    slug,
    displayName: slug,
    image: '',
    tags: [],
  }))
  const review = createMemoryStore(
    ['batch', 'other-batch'].map((id, index) => ({
      id,
      name: 'Queue',
      createdBy: index ? other.uid : actor.uid,
      createdAt: '',
      revision: 0,
      state: 'open' as const,
      baselineVersion: 1,
      plateIds: plates.map((plate) => plate.id),
      approval: null,
    }))
  )
  const store = createMemoryJobsStore(
    review,
    localJobsEnvironment('test-queue')
  )
  const deps: JobsDeps = {
    store,
    localScope: 'test-queue',
    baseline: async (id) => plates.find((plate) => plate.id === id) ?? null,
    /**
     * Read the controlled test clock so state and lease timestamps advance
     * deterministically.
     */
    now: () => time,
    id: () => `claim-${++sequence}`,
    leaseMs: 1000,
  }
  /** Enqueue a run, bind its attempt and dispatch its first stage for the scenario. */
  async function run(
    requestId = `request-${++sequence}`,
    stages: LocalRunStage[] = ['tag'],
    requestedBy: Actor = actor,
    batchId = 'batch'
  ) {
    const result = await enqueueRun(deps, requestedBy, {
      requestId,
      batchId,
      plateIds: [plates[0].id],
      stages,
    })
    if (!result.ok) throw Error(result.error)
    expect(
      await bindQueueWorkflow(deps, result.value.id, 1, `workflow-${requestId}`)
    ).toBe(true)
    await dispatchQueueStage(deps, result.value.id, 1, 0, `hook-${requestId}`)
    return result.value
  }
  /** Claim and settle the next fixture stage with the supplied worker payload. */
  async function complete(
    workerId: string,
    report: ReportInput = { ...base, suggestions: ['blue'] }
  ) {
    const claim = await claimNext(deps, workerId)
    if (!claim) throw Error('Expected claim')
    const sent = await reportResult(
      deps,
      workerId,
      claim.job.id,
      claim.claimId,
      report
    )
    expect(sent).toMatchObject({ ok: true })
    const observation = await observeQueueStage(
      deps,
      claim.job.queueRunId!,
      claim.job.queueAttempt!,
      claim.job.queueStep!
    )
    return { ...claim, observation }
  }
  return {
    deps,
    plates,
    review,
    run,
    complete,
    advance: (ms: number) => {
      time += ms
    },
  }
}

beforeEach(() => vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1'))
afterEach(() => vi.unstubAllEnvs())

test('transactional GPU bound holds across processes, queued jobs do not expire, by-id cannot bypass, production sees none', async () => {
  const s = setup()
  const first = await s.run('first')
  s.advance(1)
  await s.run('second')
  s.advance(20 * 60_000)
  const claims = await Promise.all([
    claimNext({ ...s.deps }, 'worker-one'),
    claimNext({ ...s.deps }, 'worker-two'),
  ])
  expect(claims.filter(Boolean)).toHaveLength(1)
  expect(claims.find(Boolean)?.job.queueRunId).toBe(first.id)
  expect(await claimJob(s.deps, 'bypass', `${first.id}-1-0`)).toMatchObject({
    error: 'forbidden',
  })
  const legacy = { ...s.deps, localScope: undefined }
  expect(await claimNext(legacy, 'production')).toBeNull()
  expect((await getJob(s.deps, `${first.id}-1-0`))?.leaseExpiresAt).toBe(
    s.deps.now() + 10 * 60_000
  )
})

test('Colors and Tag compete for the same GPU slot while IO permits two workers', async () => {
  const s = setup()
  await s.run('colors', ['colors'])
  s.advance(1)
  await s.run('tag', ['tag'])
  const first = await claimNext(s.deps, 'worker')
  expect(first?.job.stage).toBe('colors')
  expect(await claimNext(s.deps, 'other')).toBeNull()
  await s.run('wiki-one', ['wiki-link'], other, 'other-batch')
  await s.run('wiki-two', ['wiki-link'], owner)
  await s.run('wiki-three', ['wiki-link'], { ...owner, uid: 'second-owner' })
  expect(await claimNext(s.deps, 'io-one')).not.toBeNull()
  expect(await claimNext(s.deps, 'io-two')).not.toBeNull()
  expect(await claimNext(s.deps, 'io-three')).toBeNull()
})

test('Desktop research runs keep their full place in line on the GPU', async () => {
  const researchModelId = 'desktop-gemma4-12b'
  vi.stubEnv('RESEARCH_ENABLE_MODEL_CALLS', 'true')
  const s = setup(
    Array.from({ length: 10 }, (_, index) => `plate-${index + 1}`)
  )
  // A desktop worker always takes the first job in line.
  const claim = () => claimNext(s.deps, 'worker')
  async function enqueue(requestId: string, from: number, to: number) {
    const created = await enqueueRun(s.deps, owner, {
      batchId: 'batch',
      requestId,
      stages: ['research'],
      researchModelId,
      plateIds: s.plates.slice(from, to).map((plate) => plate.id),
    })
    if (!created.ok) throw Error(created.error)
    const { id } = created.value
    await bindQueueWorkflow(s.deps, id, 1, requestId)
    await dispatchQueueStage(s.deps, id, 1, 0, requestId)
    return id
  }

  const first = await enqueue('seven', 0, 7)
  s.advance(-1)
  const next = await enqueue('three', 7, 10)
  const status = async () => {
    const result = await listRuns(
      s.deps,
      owner,
      await readLocalWorkerCapabilities(s.deps)
    )
    if (!result.ok) throw Error(result.error)
    return result.value
  }
  const available = { available: true }
  await reportLocalWorkerCapabilities(s.deps, 'worker', {
    group: available,
    embeddings: available,
    mask: available,
    vision: available,
    pollIntervalMs: 5000,
  })
  expect(await status()).toContainEqual(
    expect.objectContaining({ id: first, status: 'queued' })
  )
  for (let index = 0; index < 7; index++) {
    if (index > 0) {
      expect(await claim()).toBeNull()
      await dispatchQueueStage(s.deps, first, 1, index, `seven-${index}`)
      expect(await status()).toContainEqual(
        expect.objectContaining({
          id: first,
          status: 'running',
          queueWait: 'worker_claim',
        })
      )
    }
    const current = await claim()
    expect(current?.job).toMatchObject({
      queueRunId: first,
      plateId: s.plates[index].id,
    })
    expect(await claim()).toBeNull()
    expect(
      await reportResult(
        s.deps,
        current!.job.workerId!,
        current!.job.id,
        current!.claimId,
        {
          ...base,
          model: current!.job.researchModel!.model,
          fieldSuggestion: {
            kind: 'fields',
            stage: 'research',
            fields: { description: 'Researched' },
            sources: ['https://example.org/wiki'],
          },
        }
      )
    ).toMatchObject({ ok: true })
    expect(await observeQueueStage(s.deps, first, 1, index)).toEqual({
      phase: index === 6 ? 'done' : 'next',
    })
    if (index < 6) {
      expect(await claim()).toBeNull()
      expect(await status()).toContainEqual(
        expect.objectContaining({
          id: next,
          status: 'queued',
          queueWait: 'prior_run',
        })
      )
    }
    expect(await status()).toContainEqual(
      expect.objectContaining({
        id: first,
        status: index === 6 ? 'completed' : 'running',
      })
    )
  }
  expect((await claim())?.job).toMatchObject({
    queueRunId: next,
    plateId: s.plates[7].id,
  })
})

test('an unavailable worker capability fails the stage rather than counting it as a no-result or running dependants', async () => {
  const s = setup()
  const run = await s.run('unavailable', ['describe', 'story'])
  const claim = (await claimNext(s.deps, 'worker'))!
  expect(
    await reportResult(s.deps, 'worker', claim.job.id, claim.claimId, {
      ...base,
      stageError: 'unavailable',
    })
  ).toMatchObject({ ok: true })
  await observeQueueStage(s.deps, run.id, 1, 0)
  const [saved] = await s.deps.store.transaction((tx) => tx.runs())
  expect(saved.status).toBe('failed')
  expect(saved.attempts[0]).toMatchObject({ cursor: 0, error: 'unavailable' })
  expect(saved.attempts[0].outcome).toBeUndefined()
  expect(
    await dispatchQueueStage(s.deps, run.id, 1, 1, 'downstream')
  ).toBeNull()
  expect(
    await retryRun(s.deps, actor, run.id, 'capability-fixed')
  ).toMatchObject({ ok: true })
})

test('GPU steps from two requesters run strictly in submission order, across stage boundaries', async () => {
  const s = setup()
  const first = await s.run('editor-first', ['describe', 'story'])
  s.advance(1)
  const theirs = await s.run('other-first', ['tag'], other, 'other-batch')
  s.advance(1)
  const second = await s.run('editor-second')
  const described = await s.complete('worker', {
    ...base,
    fieldSuggestion: {
      kind: 'fields',
      stage: 'describe',
      fields: { description: 'Sourced' },
      sources: ['https://example.org/wiki'],
    },
  })
  expect(described.job.queueRunId).toBe(first.id)
  expect(described.observation).toEqual({ phase: 'next' })
  // The earlier run's next GPU step is not dispatched yet but keeps its place.
  expect(await claimNext(s.deps, 'worker')).toBeNull()
  expect(await listRuns(s.deps, owner)).toMatchObject({
    value: expect.arrayContaining([
      expect.objectContaining({ id: theirs.id, queueWait: 'prior_run' }),
      expect.objectContaining({ id: second.id, queueWait: 'prior_run' }),
    ]),
  })
  await dispatchQueueStage(s.deps, first.id, 1, 1, 'editor-first-story')
  const story = await claimNext(s.deps, 'worker')
  expect(story?.job).toMatchObject({ queueRunId: first.id, queueStep: 1 })
  expect(await claimNext(s.deps, 'other-worker')).toBeNull()
  expect(
    await reportResult(s.deps, 'worker', story!.job.id, story!.claimId, {
      ...base,
      stageError: 'unavailable',
    })
  ).toMatchObject({ ok: true })
  expect(await observeQueueStage(s.deps, first.id, 1, 1)).toEqual({
    phase: 'done',
  })
  expect((await s.complete('worker')).job.queueRunId).toBe(theirs.id)
  expect((await s.complete('worker')).job.queueRunId).toBe(second.id)
})

test('cancelling an earlier GPU run between steps releases its place in line', async () => {
  const s = setup()
  const first = await s.run('editor-first', ['describe', 'story'])
  s.advance(1)
  const theirs = await s.run('other-first', ['tag'], other, 'other-batch')
  await s.complete('worker', {
    ...base,
    fieldSuggestion: {
      kind: 'fields',
      stage: 'describe',
      fields: { description: 'Sourced' },
      sources: ['https://example.org/wiki'],
    },
  })
  expect(await claimNext(s.deps, 'worker')).toBeNull()
  expect(await cancelRun(s.deps, actor, first.id)).toMatchObject({
    value: { status: 'cancelled' },
  })
  expect((await claimNext(s.deps, 'worker'))?.job.queueRunId).toBe(theirs.id)
})

/** Enqueue a Gateway Tag run over plates [from, to) and bind its workflow. */
async function gatewayRun(
  s: ReturnType<typeof setup>,
  requestedBy: Actor,
  requestId: string,
  from: number,
  to: number,
  batchId = 'batch'
) {
  const created = await enqueueRun(
    s.deps,
    { ...requestedBy, role: 'owner' },
    {
      requestId,
      batchId,
      plateIds: s.plates.slice(from, to).map((plate) => plate.id),
      stages: ['tag'],
      tagModelId: 'gateway-gemma4-26b',
    }
  )
  if (!created.ok) throw Error(created.error)
  const { id } = created.value
  await bindQueueWorkflow(s.deps, id, 1, `workflow-${requestId}`)
  return id
}

/** Try to claim every listed hosted job and return the claims that landed. */
async function claimHosted(s: ReturnType<typeof setup>, ids: string[]) {
  const claims = []
  for (const id of ids) {
    const claim = await claimHostedQueueJob(s.deps, id)
    if (claim) claims.push(claim)
  }
  return claims
}

/** Report a Tag result for each hosted claim and settle its step. */
async function finishHosted(
  s: ReturnType<typeof setup>,
  claims: NonNullable<Awaited<ReturnType<typeof claimHostedQueueJob>>>[]
) {
  for (const { job, claimId } of claims) {
    expect(
      await reportResult(s.deps, 'hosted', job.id, claimId, {
        ...base,
        suggestions: ['blue'],
      })
    ).toMatchObject({ ok: true })
    await observeQueueStage(s.deps, job.queueRunId!, 1, job.queueStep!)
  }
}

test('a Gateway Tag run queued alone takes every hosted slot, then shares freed slots with a later run', async () => {
  vi.stubEnv('TAGGING_MODELS', 'gateway-gemma4-26b')
  const s = setup(
    Array.from({ length: 10 }, (_, index) => `plate-${index + 1}`)
  )
  const large = await gatewayRun(s, actor, 'large', 0, 8)
  const wave = await dispatchGatewayTagWave(s.deps, large, 1, 0)
  expect(wave).toHaveLength(6)
  // Alone, the run holds all six Gateway slots.
  const held = await claimHosted(
    s,
    wave.map((job) => job.id)
  )
  expect(held).toHaveLength(6)
  s.advance(1)
  const later = await gatewayRun(s, other, 'later', 8, 10, 'other-batch')
  const laterJobs = (await dispatchGatewayTagWave(s.deps, later, 1, 0)).map(
    (job) => job.id
  )
  expect(await claimHosted(s, laterJobs)).toEqual([])
  expect(await listRuns(s.deps, owner)).toMatchObject({
    value: expect.arrayContaining([
      expect.objectContaining({ id: large, status: 'running' }),
      expect.objectContaining({
        id: later,
        status: 'queued',
        queueWait: 'prior_run',
      }),
    ]),
  })
  // The large run finishes a plate and has its seventh plate waiting, but the freed
  // slot goes to the later run, which holds none.
  await finishHosted(s, held.slice(0, 1))
  const [seventh] = (await dispatchGatewayTagWave(s.deps, large, 1, 1))
    .map((job) => job.id)
    .filter((id) => !wave.some((job) => job.id === id))
  expect(seventh).toBe(`${large}-1-6`)
  expect(await claimHostedQueueJob(s.deps, seventh)).toBeNull()
  expect((await claimHosted(s, laterJobs)).map((c) => c.job.id)).toEqual([
    laterJobs[0],
  ])
  // The next freed slot also goes to the later run: it holds one, the large run five.
  await finishHosted(s, held.slice(1, 2))
  expect(await claimHostedQueueJob(s.deps, seventh)).toBeNull()
  expect(
    (await claimHosted(s, laterJobs.slice(1))).map((c) => c.job.id)
  ).toEqual([laterJobs[1]])
  // With nothing else waiting, the large run takes the next free slot.
  await finishHosted(s, held.slice(2, 3))
  expect((await claimHostedQueueJob(s.deps, seventh))?.job.state).toBe(
    'claimed'
  )
})

test('two queued Gateway Tag runs from different curators hold hosted slots at the same time and both finish', async () => {
  vi.stubEnv('TAGGING_MODELS', 'gateway-gemma4-26b')
  const s = setup(
    Array.from({ length: 12 }, (_, index) => `plate-${index + 1}`)
  )
  const first = await gatewayRun(s, actor, 'first', 0, 6)
  s.advance(1)
  const second = await gatewayRun(s, other, 'second', 6, 12, 'other-batch')
  const jobs = [
    ...(await dispatchGatewayTagWave(s.deps, first, 1, 0)),
    ...(await dispatchGatewayTagWave(s.deps, second, 1, 0)),
  ].map((job) => job.id)
  expect(jobs).toHaveLength(12)
  // Offered the earlier run's jobs first, the six slots still split three and three.
  const round = await claimHosted(s, jobs)
  const share = (claims: typeof round) =>
    [first, second].map(
      (id) => claims.filter((claim) => claim.job.queueRunId === id).length
    )
  expect(share(round)).toEqual([3, 3])
  expect(await listRuns(s.deps, owner)).toMatchObject({
    value: expect.arrayContaining(
      [first, second].map((id) =>
        expect.objectContaining({ id, status: 'running' })
      )
    ),
  })
  await finishHosted(s, round)
  const rest = await claimHosted(s, jobs)
  expect(share(rest)).toEqual([3, 3])
  await finishHosted(s, rest)
  expect(await listRuns(s.deps, owner)).toMatchObject({
    value: expect.arrayContaining(
      [first, second].map((id) =>
        expect.objectContaining({ id, status: 'completed' })
      )
    ),
  })
})

test('desktop GPU work is not shared between runs: a later curator waits for every plate of an earlier run', async () => {
  const s = setup(['one', 'two', 'three', 'four'])
  const enqueue = async (
    requestId: string,
    requestedBy: Actor,
    batchId: string,
    plateIds: string[]
  ) => {
    const created = await enqueueRun(s.deps, requestedBy, {
      requestId,
      batchId,
      plateIds,
      stages: ['tag'],
    })
    if (!created.ok) throw Error(created.error)
    await bindQueueWorkflow(s.deps, created.value.id, 1, requestId)
    await dispatchQueueStage(s.deps, created.value.id, 1, 0, requestId)
    return created.value.id
  }
  const ids = s.plates.map((plate) => plate.id)
  const earlier = await enqueue('earlier', actor, 'batch', ids.slice(0, 3))
  s.advance(1)
  const later = await enqueue('later', other, 'other-batch', ids.slice(3))
  const order: string[] = []
  for (let index = 0; index < 4; index++) {
    const { job, observation } = await s.complete('worker')
    order.push(job.queueRunId!)
    if (job.queueRunId === earlier && observation.phase === 'next')
      await dispatchQueueStage(
        s.deps,
        earlier,
        1,
        job.queueStep! + 1,
        `earlier-${job.queueStep! + 1}`
      )
  }
  expect(order).toEqual([earlier, earlier, earlier, later])
})

test('Eve research runs from the same requester progress concurrently up to the shared I/O limit', async () => {
  vi.stubEnv('RESEARCH_ENABLE_MODEL_CALLS', 'true')
  const s = setup(['one', 'two', 'three'])
  const ids: string[] = []
  for (const [index, plate] of s.plates.entries()) {
    const created = await enqueueRun(s.deps, owner, {
      batchId: 'batch',
      requestId: `eve-${index}`,
      stages: ['research'],
      researchModelId: 'eve-gemini-2-5-flash-lite',
      plateIds: [plate.id],
    })
    if (!created.ok) throw Error(created.error)
    const { id } = created.value
    await bindQueueWorkflow(s.deps, id, 1, `eve-${index}`)
    await dispatchQueueStage(s.deps, id, 1, 0, `eve-${index}`)
    ids.push(id)
    s.advance(1)
  }
  const claims = await Promise.all(
    ids.map((id) => claimHostedQueueJob({ ...s.deps }, `${id}-1-0`))
  )
  expect(claims.map((claim) => claim?.job.queueRunId ?? null)).toEqual([
    ids[0],
    ids[1],
    null,
  ])
})

test('drafts from concurrent runs in the same Batch both land', async () => {
  vi.stubEnv('TAGGING_MODELS', 'gateway-gemma4-26b')
  const s = setup()
  const runs: string[] = []
  for (const plate of s.plates) {
    const created = await enqueueSelection(
      s.deps,
      { ...actor, role: 'owner' },
      {
        requestId: `draft-${plate.slug}`,
        batchId: 'batch',
        plateIds: [plate.id],
        stages: ['tag'],
        tagModelId: 'gateway-gemma4-26b',
      }
    )
    if (!created.ok) throw Error(created.error)
    const [run] = created.value
    await bindQueueWorkflow(s.deps, run.id, 1, `workflow-${plate.slug}`)
    await dispatchQueueStage(s.deps, run.id, 1, 0, `hook-${plate.slug}`)
    runs.push(run.id)
    s.advance(1)
  }
  const claims = await Promise.all(
    runs.map((id) => claimHostedQueueJob(s.deps, `${id}-1-0`))
  )
  for (const [index, claim] of claims.entries())
    expect(
      await reportResult(s.deps, 'hosted', claim!.job.id, claim!.claimId, {
        ...base,
        suggestions: [index ? 'red' : 'blue'],
      })
    ).toMatchObject({ ok: true })
  expect(
    await Promise.all(
      runs.map((id) => observeQueueStage({ ...s.deps }, id, 1, 0))
    )
  ).toEqual([{ phase: 'done' }, { phase: 'done' }])
  const saved = await s.review.readBatch('batch')
  expect(saved?.batch.revision).toBe(2)
  expect(
    saved?.edits.map((edit) => [edit.plateId, edit.fields.tags]).sort()
  ).toEqual([
    ['AK.one', ['blue']],
    ['AK.two', ['red']],
  ])
  expect(await listRuns(s.deps, actor)).toMatchObject({
    value: [{ status: 'completed' }, { status: 'completed' }],
  })
})

test('sequential projected Wiki/Describe/Story survives server reconstruction and missed callback, never writes Batch', async () => {
  const s = setup()
  const run = await s.run('chain', ['wiki-link', 'describe', 'story'])
  const wiki = await s.complete('worker', {
    ...base,
    fieldSuggestion: {
      kind: 'fields',
      stage: 'wiki-link',
      fields: { wikiUrl: 'https://example.org/wiki' },
      sources: ['https://example.org/wiki'],
    },
  })
  await dispatchQueueStage({ ...s.deps }, run.id, 1, 1, 'description-hook')
  const describe = await claimNext(s.deps, 'worker')
  expect(describe?.job.inputPlate?.wikiUrl).toBe('https://example.org/wiki')
  expect(describe?.job.inputHash).toBe(wiki.job.inputHash)
  expect(describe?.job.executionHash).not.toBe(wiki.job.inputHash)
  await reportResult(s.deps, 'worker', describe!.job.id, describe!.claimId, {
    ...base,
    fieldSuggestion: {
      kind: 'fields',
      stage: 'describe',
      fields: { description: 'Sourced' },
      sources: ['https://example.org/wiki'],
    },
  })
  expect(await observeQueueStage({ ...s.deps }, run.id, 1, 1)).toEqual({
    phase: 'next',
  })
  await dispatchQueueStage(s.deps, run.id, 1, 2, 'story-hook')
  expect((await claimNext(s.deps, 'worker'))?.job.inputPlate?.description).toBe(
    'Sourced'
  )
  expect(await s.review.listEdits('batch')).toEqual([])
})

test('an explicit handler failure still stops downstream stages', async () => {
  const s = setup()
  const run = await s.run('failure', ['describe', 'story'])
  const claim = (await claimNext(s.deps, 'worker'))!
  await failLocalJob(
    s.deps,
    'worker',
    claim.job.id,
    claim.claimId,
    'no_handler'
  )
  expect(await observeQueueStage(s.deps, run.id, 1, 0)).toEqual({
    phase: 'done',
  })
  expect(await dispatchQueueStage(s.deps, run.id, 1, 1, 'never')).toBeNull()
  const saved = (await s.deps.store.transaction((tx) => tx.runs()))[0]
  expect(saved).toMatchObject({
    status: 'failed',
    attempts: [{ cursor: 0, error: 'no_handler' }],
  })
})

test('a missing Wiki result stops the research run before any model job is dispatched', async () => {
  const s = setup()
  const run = await s.run('no-sources', ['wiki-link', 'describe', 'story'])
  await s.complete('worker', { ...base, stageError: 'no_sources' })
  expect(
    await dispatchQueueStage(s.deps, run.id, 1, 1, 'describe-hook')
  ).toBeNull()
  expect(await claimNext(s.deps, 'worker')).toBeNull()
  const [saved] = await s.deps.store.transaction((tx) => tx.runs())
  expect(saved).toMatchObject({
    status: 'failed',
    attempts: [
      {
        cursor: 3,
        outcome: 'no_result',
        error: 'no_sources',
        steps: [
          {
            stage: 'wiki-link',
            status: 'failed',
            reason: 'no_sources',
            endedAt: 100,
          },
          {
            stage: 'describe',
            status: 'skipped',
            reason: 'upstream_failed',
            endedAt: 100,
          },
          {
            stage: 'story',
            status: 'skipped',
            reason: 'upstream_failed',
            endedAt: 100,
          },
        ],
      },
    ],
  })
  expect(await s.review.listEdits('batch')).toEqual([])
  const retry = await retryRun(s.deps, actor, run.id, 'retry-source')
  if (!retry.ok) throw Error(retry.error)
  expect(retry.value.attempts[0].steps.map((step) => step.status)).toEqual([
    'failed',
    'skipped',
    'skipped',
  ])
  expect(
    retry.value.attempts[1].steps.every(
      (step) =>
        step.status === undefined &&
        step.endedAt === undefined &&
        step.reason === undefined
    )
  ).toBe(true)
})

test('three missing links skip only their plates in a 21-plate selection', async () => {
  const s = setup(Array.from({ length: 21 }, (_, index) => `plate-${index}`))
  const created = await enqueueSelection(s.deps, actor, {
    requestId: 'mixed-links',
    batchId: 'batch',
    plateIds: s.plates.map((plate) => plate.id),
    stages: ['wiki-link', 'describe'],
  })
  if (!created.ok) throw Error(created.error)
  const [run] = created.value
  const missing = new Set([0, 10, 20])
  const url = 'https://example.org/wiki'
  for (const [index, plate] of s.plates.entries()) {
    const wikiIndex = index * 2
    expect(
      await dispatchQueueStage(
        s.deps,
        run.id,
        1,
        wikiIndex,
        `hook-${wikiIndex}`
      )
    ).toBeTruthy()
    const wiki = await s.complete(
      'worker',
      missing.has(index)
        ? { ...base, stageError: 'no_sources' }
        : {
            ...base,
            fieldSuggestion: {
              kind: 'fields',
              stage: 'wiki-link',
              fields: { wikiUrl: url },
              sources: [url],
            },
          }
    )
    expect(wiki.job.plateId).toBe(plate.id)
    if (missing.has(index)) {
      expect(wiki.observation).toEqual(
        index === 20
          ? { phase: 'done' }
          : { phase: 'next', nextIndex: wikiIndex + 2 }
      )
      expect(
        await dispatchQueueStage(
          s.deps,
          run.id,
          1,
          wikiIndex + 1,
          `skip-${wikiIndex}`
        )
      ).toBeNull()
      expect(await claimNext(s.deps, 'worker')).toBeNull()
      continue
    }
    expect(
      await dispatchQueueStage(
        s.deps,
        run.id,
        1,
        wikiIndex + 1,
        `describe-${wikiIndex}`
      )
    ).toBeTruthy()
    const description = await s.complete('worker', {
      ...base,
      fieldSuggestion: {
        kind: 'fields',
        stage: 'describe',
        fields: { description: 'A sourced description' },
        sources: [url],
      },
    })
    expect(description.job.inputPlate?.wikiUrl).toBe(url)
  }
  const [saved] = await s.deps.store.transaction((tx) => tx.runs())
  const [attempt] = saved.attempts
  expect(saved).toMatchObject({
    status: 'completed',
    draftPlateIds: s.plates
      .filter((_, index) => !missing.has(index))
      .map((plate) => plate.id),
  })
  expect(attempt).toMatchObject({ outcome: 'partial', cursor: 42 })
  expect(attempt.completedJobIds).toHaveLength(36)
  for (const index of missing) {
    expect(attempt.steps.slice(index * 2, index * 2 + 2)).toMatchObject([
      { status: 'failed', reason: 'no_sources' },
      { status: 'skipped', reason: 'upstream_failed' },
    ])
  }
  expect(await s.review.listEdits('batch')).toHaveLength(18)
  const retried = await retryRun(s.deps, actor, run.id, 'retry-missing-links')
  if (!retried.ok) throw Error(retried.error)
  expect(retried.value.attempts[1]).toMatchObject({
    cursor: 0,
    completedJobIds: attempt.completedJobIds,
  })
  expect(
    retried.value.attempts[1].steps.filter(
      (step) => step.status === 'completed'
    )
  ).toHaveLength(36)

  for (const index of missing) {
    const wikiIndex = index * 2
    expect(
      await dispatchQueueStage(
        s.deps,
        run.id,
        2,
        wikiIndex,
        `retry-wiki-${index}`
      )
    ).toBeTruthy()
    await s.complete('worker', {
      ...base,
      fieldSuggestion: {
        kind: 'fields',
        stage: 'wiki-link',
        fields: { wikiUrl: url },
        sources: [url],
      },
    })
    expect(
      await dispatchQueueStage(
        s.deps,
        run.id,
        2,
        wikiIndex + 1,
        `retry-describe-${index}`
      )
    ).toBeTruthy()
    const result = await s.complete('worker', {
      ...base,
      fieldSuggestion: {
        kind: 'fields',
        stage: 'describe',
        fields: { description: 'A sourced description' },
        sources: [url],
      },
    })
    expect(result.observation).toEqual(
      index === 20
        ? { phase: 'done' }
        : { phase: 'next', nextIndex: index === 0 ? 20 : 40 }
    )
  }
  const [finished] = await s.deps.store.transaction((tx) => tx.runs())
  expect(finished.status).toBe('completed')
  expect(finished.attempts[1].outcome).toBeUndefined()
  expect(finished.attempts[1].completedJobIds).toHaveLength(42)
  expect(await s.review.listEdits('batch')).toHaveLength(21)
})

test.each(['stage_failed', 'no_saved_sources'])(
  'Research %s skips the rest of that plate and the next plate still runs',
  async (reason) => {
    const s = setup()
    const created = await enqueueSelection(s.deps, actor, {
      requestId: 'research-worker-failure',
      batchId: 'batch',
      plateIds: s.plates.map((plate) => plate.id),
      stages: ['research', 'wiki-link', 'describe'],
      researchModelId: 'desktop-gemma4-12b',
      options: {
        research: {
          policy: 'fill-missing',
          reuseSavedSources: reason === 'no_saved_sources',
        },
      },
    })
    if (!created.ok) throw Error(created.error)
    const [run] = created.value
    await dispatchQueueStage(s.deps, run.id, 1, 0, 'first')
    const claim = (await claimNext(s.deps, 'worker', {
      supportsSavedSources: true,
    }))!
    expect(claim.job.stage).toBe('research')
    const model = claim.job.researchModel!.model
    if (reason === 'no_saved_sources') {
      expect(
        await reportResult(s.deps, 'worker', claim.job.id, claim.claimId, {
          ...base,
          model,
          stageError: 'no_sources',
        })
      ).toMatchObject({ ok: true })
    } else {
      await failLocalJob(s.deps, 'worker', claim.job.id, claim.claimId, reason)
    }
    expect(await observeQueueStage(s.deps, run.id, 1, 0)).toEqual({
      phase: 'next',
      nextIndex: 3,
    })
    expect(await dispatchQueueStage(s.deps, run.id, 1, 1, 'skipped')).toBeNull()
    expect(await dispatchQueueStage(s.deps, run.id, 1, 2, 'skipped')).toBeNull()

    const url = 'https://example.org/wiki'
    const results = [
      { stage: 'research', fields: { description: 'Researched' } },
      { stage: 'wiki-link', fields: { wikiUrl: url } },
      { stage: 'describe', fields: { description: 'Sourced description' } },
    ] as const
    for (const [offset, result] of results.entries()) {
      const index = 3 + offset
      expect(
        await dispatchQueueStage(s.deps, run.id, 1, index, 'second')
      ).toBeTruthy()
      const next = (await claimNext(s.deps, 'worker', {
        supportsSavedSources: true,
      }))!
      expect(next.job.plateId).toBe(s.plates[1].id)
      expect(
        await reportResult(s.deps, 'worker', next.job.id, next.claimId, {
          ...base,
          model,
          fieldSuggestion: { kind: 'fields', ...result, sources: [url] },
        })
      ).toMatchObject({ ok: true })
      await observeQueueStage(s.deps, run.id, 1, index)
    }
    const [saved] = await s.deps.store.transaction((tx) => tx.runs())
    expect(saved).toMatchObject({
      status: 'completed',
      draftPlateIds: [s.plates[1].id],
    })
    expect(saved.attempts[0].steps).toMatchObject([
      { status: reason === 'no_saved_sources' ? 'skipped' : 'failed', reason },
      {
        status: 'skipped',
        reason:
          reason === 'no_saved_sources'
            ? 'upstream_skipped'
            : 'upstream_failed',
      },
      {
        status: 'skipped',
        reason:
          reason === 'no_saved_sources'
            ? 'upstream_skipped'
            : 'upstream_failed',
      },
      { status: 'completed' },
      { status: 'completed' },
      { status: 'completed' },
    ])
  }
)

test('dispatch refuses a persisted run that advanced without its selected Wiki prerequisite', async () => {
  const s = setup()
  const run = await s.run('legacy-empty', ['wiki-link', 'describe'])
  const wikiJobId = `${run.id}-1-0`
  await s.deps.store.transaction(async (tx) => {
    const [saved] = await tx.runs()
    const wiki = (await tx.get(wikiJobId))!
    tx.set({
      ...wiki,
      state: 'completed',
      result: { ...base, suggestions: [], stageError: 'no_sources' },
    })
    saved.attempts[0].cursor = 1
    saved.attempts[0].completedJobIds.push(wikiJobId)
    tx.setRun(saved)
  })
  expect(
    await dispatchQueueStage(s.deps, run.id, 1, 1, 'describe-hook')
  ).toBeNull()
  expect(await claimNext(s.deps, 'worker')).toBeNull()
  const [saved] = await s.deps.store.transaction((tx) => tx.runs())
  expect(saved).toMatchObject({
    status: 'failed',
    attempts: [{ error: 'missing_wiki_link' }],
  })
})

test('cancellation is immediate before claim but remains requested until active worker acknowledges safe end', async () => {
  const s = setup()
  const queued = await s.run('queued')
  expect(await cancelRun(s.deps, actor, queued.id)).toMatchObject({
    value: { status: 'cancelled' },
  })
  expect(await claimNext(s.deps, 'worker')).toBeNull()
  const active = await s.run('active', ['tag', 'story'])
  const claim = (await claimNext(s.deps, 'worker'))!
  expect(await cancelRun(s.deps, actor, active.id)).toMatchObject({
    value: { status: 'running', cancelRequestedAt: 100 },
  })
  s.advance(11 * 60_000)
  expect(await observeQueueStage(s.deps, active.id, 1, 0)).toEqual({
    phase: 'waiting',
  })
  await s.run('waiting')
  expect(await claimNext(s.deps, 'second')).toBeNull()
  expect(await retryRun(s.deps, actor, active.id, 'too-soon')).toMatchObject({
    error: 'invalid_state',
  })
  await failLocalJob(
    s.deps,
    'worker',
    claim.job.id,
    claim.claimId,
    'lease_expired'
  )
  await observeQueueStage(s.deps, active.id, 1, 0)
  expect(
    (await s.deps.store.transaction((tx) => tx.runs())).find(
      (run) => run.id === active.id
    )?.status
  ).toBe('cancelled')
  expect(await claimNext(s.deps, 'second')).not.toBeNull()
})

test('retry preserves completed result provenance, deduplicates command, rejects changed Batch and bounds attempt growth', async () => {
  const s = setup()
  const run = await s.run('retry', ['describe', 'story'])
  const done = await s.complete('worker', {
    ...base,
    fieldSuggestion: {
      kind: 'fields',
      stage: 'describe',
      fields: { description: 'Sourced' },
      sources: ['https://example.org/wiki'],
    },
  })
  await dispatchQueueStage(s.deps, run.id, 1, 1, 'story')
  const failed = (await claimNext(s.deps, 'worker'))!
  await failLocalJob(
    s.deps,
    'worker',
    failed.job.id,
    failed.claimId,
    'stage_failed'
  )
  await observeQueueStage(s.deps, run.id, 1, 1)
  const retry = await retryRun(s.deps, actor, run.id, 'retry-command')
  expect(retry).toMatchObject({
    value: {
      attempts: [
        { number: 1, status: 'failed' },
        { number: 2, cursor: 1, completedJobIds: [done.job.id] },
      ],
    },
  })
  expect(await retryRun(s.deps, actor, run.id, 'retry-command')).toEqual(retry)
  await cancelRun(s.deps, actor, run.id)
  const batch = (await s.review.getBatch('batch'))!
  await s.review.commit('batch', batch.revision, {
    batch: { ...batch, baselineVersion: 2, revision: batch.revision + 1 },
  })
  expect(await retryRun(s.deps, actor, run.id, 'changed')).toMatchObject({
    error: 'stale_input',
  })
  await s.deps.store.transaction(async (tx) => {
    const [saved] = await tx.runs()
    saved.attempts = Array.from(
      { length: maxQueueAttempts },
      () => saved.attempts[0]
    )
    tx.setRun(saved)
  })
  expect(await retryRun(s.deps, actor, run.id, 'overflow')).toMatchObject({
    error: 'attempt_limit',
  })
})

test('list/cancel/retry enforce requester/Batch ownership and read-only mutations even for Owner', async () => {
  const s = setup()
  const run = await s.run('private')
  expect(await listRuns(s.deps, other)).toEqual({ ok: true, value: [] })
  expect(await listRuns(s.deps, owner)).toMatchObject({
    ok: true,
    value: [{ id: run.id }],
  })
  expect(await cancelRun(s.deps, other, run.id)).toMatchObject({
    error: 'forbidden',
  })
  expect(await retryRun(s.deps, other, run.id, 'retry')).toMatchObject({
    error: 'forbidden',
  })
  const batch = (await s.review.getBatch('batch'))!
  await s.review.commit('batch', 0, {
    batch: { ...batch, revision: 1, state: 'submitted' },
  })
  expect(await cancelRun(s.deps, owner, run.id)).toMatchObject({
    error: 'invalid_state',
  })
})

test('unknown, retired and hosted model choices fail before any durable write; oversized snapshot fails honestly', async () => {
  const s = setup()
  const input = {
    requestId: 'model',
    batchId: 'batch',
    plateIds: ['AK.one'],
    stages: ['tag' as const],
  }
  expect(
    await enqueueRun(s.deps, actor, { ...input, modelId: 'invented' })
  ).toMatchObject({ error: 'bad_request' })
  expect(
    await enqueueRun(s.deps, actor, { ...input, modelId: 'gateway-gemma4-26b' })
  ).toMatchObject({ error: 'unavailable' })
  vi.stubEnv('TAGGING_MODELS', 'desktop-gemma4-12b')
  expect(
    await enqueueRun(s.deps, actor, { ...input, modelId: 'desktop-gemma4-26b' })
  ).toMatchObject({ error: 'unavailable' })
  const big = {
    ...s.deps,
    baseline: async () => ({
      ...s.plates[0],
      description: 'x'.repeat(400_000),
    }),
  }
  expect(await enqueueRun(big, actor, input)).toMatchObject({
    error: 'payload_too_large',
  })
  expect(await s.deps.store.transaction((tx) => tx.runs())).toEqual([])
})

test('all direct local physical claims stay fenced after lease expiry and explicit workflow expiry; production expiry remains terminal', async () => {
  const s = setup()
  await createJob(s.deps, {
    id: 'direct',
    batchId: 'batch',
    plateId: 'AK.one',
    requestedBy: actor.uid,
    stage: 'describe',
  })
  const claim = (await claimNext(s.deps, 'old-worker'))!
  await s.run('next')
  s.advance(11 * 60_000)
  expect(await claimNext({ ...s.deps }, 'new-worker')).toBeNull()
  expect(await claimJob(s.deps, 'by-id', claim.job.id)).toMatchObject({
    error: 'claim_mismatch',
  })
  expect(await expireJob(s.deps, claim.job.id)).toMatchObject({
    value: { state: 'claimed', recoveryNeededAt: s.deps.now() },
  })
  expect(await claimNext(s.deps, 'after-workflow-expiry')).toBeNull()
  await failLocalJob(
    s.deps,
    'old-worker',
    claim.job.id,
    claim.claimId,
    'lease_expired'
  )
  expect(await claimNext(s.deps, 'new-worker')).not.toBeNull()
  const production = { ...s.deps, localScope: undefined }
  await createJob(production, {
    id: 'production',
    batchId: 'batch',
    plateId: 'AK.one',
    requestedBy: actor.uid,
  })
  expect(await expireJob(production, 'production')).toMatchObject({
    value: { state: 'expired' },
  })
})

test('list retains every unremoved run and allows opening older archived results by ID', async () => {
  const s = setup()
  const active = await s.run('active-old')
  await s.deps.store.transaction(async (tx) => {
    const [template] = await tx.runs()
    for (let index = 0; index < 60; index++)
      tx.setRun({
        ...template,
        id: `history-${index}`,
        createdAt: 200 + index,
        status: 'completed',
      })
    for (let index = 0; index < 60; index++)
      tx.setRun({
        ...template,
        id: `invisible-${index}`,
        createdAt: 300 + index,
        status: 'completed',
        batchId: 'missing',
      })
    for (let index = 0; index < 60; index++)
      tx.setRun({
        ...template,
        id: `archived-${index}`,
        status: 'completed',
        dismissedAt: 400 + index,
      })
  })
  const listed = await listRuns(s.deps, actor)
  if (!listed.ok) throw Error(listed.error)
  expect(listed.value).toHaveLength(111)
  expect(
    listed.value.some((run) => run.id === active.id && run.status === 'queued')
  ).toBe(true)
  expect(
    listed.value.filter(
      (run) => run.status === 'completed' && run.dismissedAt === undefined
    )
  ).toHaveLength(60)
  expect(
    listed.value.filter((run) => run.dismissedAt !== undefined)
  ).toHaveLength(50)
  expect(listed.value.some((run) => run.id === 'archived-0')).toBe(false)
  const requested = await listRuns(s.deps, actor, undefined, 'archived-0')
  expect(
    requested.ok && requested.value.some((run) => run.id === 'archived-0')
  ).toBe(true)
  const claim = (await claimNext(s.deps, 'worker'))!
  s.advance(1000)
  await failLocalJob(
    s.deps,
    'worker',
    claim.job.id,
    claim.claimId,
    'stage_failed'
  )
  await observeQueueStage(s.deps, active.id, 1, 0)
  const failed = await listRuns(s.deps, actor)
  expect(failed).toMatchObject({ ok: true })
  if (!failed.ok) throw Error(failed.error)
  expect(failed.value.find((run) => run.id === active.id)).toMatchObject({
    status: 'failed',
    editable: true,
  })
  expect(
    await retryRun(s.deps, actor, active.id, 'retry-old-visible')
  ).toMatchObject({ ok: true })
})

test('dismissing a terminal card preserves its history, and retry restores it to the rail', async () => {
  const s = setup()
  const run = await s.run('dismiss-card')
  expect(await dismissRun(s.deps, actor, run.id)).toEqual({
    ok: false,
    error: 'invalid_state',
  })
  const claim = (await claimNext(s.deps, 'worker'))!
  await failLocalJob(
    s.deps,
    'worker',
    claim.job.id,
    claim.claimId,
    'stage_failed'
  )
  await observeQueueStage(s.deps, run.id, 1, 0)
  expect(await dismissRun(s.deps, other, run.id)).toEqual({
    ok: false,
    error: 'not_found',
  })
  expect(await dismissRun(s.deps, actor, run.id)).toMatchObject({
    ok: true,
    value: { dismissedAt: 100, status: 'failed' },
  })
  s.advance(500)
  expect(await dismissRun(s.deps, actor, run.id)).toMatchObject({
    ok: true,
    value: { dismissedAt: 100 },
  })
  expect(await listRuns(s.deps, actor)).toMatchObject({
    value: [{ id: run.id, dismissedAt: 100, jobs: [{ id: claim.job.id }] }],
  })
  const retried = await retryRun(s.deps, actor, run.id, 'retry-dismissed')
  if (!retried.ok) throw Error(retried.error)
  expect(retried.value.status).toBe('queued')
  expect(retried.value).not.toHaveProperty('dismissedAt')
})

test('queued cards distinguish an occupied GPU from a released failed claim and an offline worker', async () => {
  const s = setup()
  const first = await s.run('gpu-holder', ['tag'], other, 'other-batch')
  const claim = (await claimNext(s.deps, 'worker'))!
  const queued = await s.run('gpu-waiter')
  const list = async () =>
    listRuns(s.deps, actor, await readLocalWorkerCapabilities(s.deps))
  expect(await list()).toMatchObject({
    value: [{ id: queued.id, queueWait: 'gpu_busy' }],
  })
  s.advance(11 * 60_000)
  expect(await list()).toMatchObject({
    value: [{ id: queued.id, queueWait: 'gpu_recovery' }],
  })
  await failLocalJob(
    s.deps,
    'worker',
    claim.job.id,
    claim.claimId,
    'lease_expired'
  )
  await observeQueueStage(s.deps, first.id, 1, 0)
  expect(await list()).toMatchObject({
    value: [{ id: queued.id, queueWait: 'worker_offline' }],
  })
  const available = { available: true }
  await reportLocalWorkerCapabilities(s.deps, 'worker', {
    group: available,
    embeddings: available,
    mask: available,
    vision: available,
    pollIntervalMs: 5000,
  })
  expect(await list()).toMatchObject({
    value: [{ id: queued.id, queueWait: 'worker_claim' }],
  })
})

test('a dead worker stays reserved until explicit exact stale-claim recovery confirms it stopped', async () => {
  const s = setup()
  const first = await s.run('dead-worker')
  const claim = (await claimNext(s.deps, 'dead-worker'))!
  await s.run('waiting-behind')
  expect(
    await confirmStoppedWorker(
      s.deps,
      actor,
      first.id,
      claim.job.id,
      claim.claimId
    )
  ).toMatchObject({ error: 'invalid_state' })
  s.advance(11 * 60_000)
  await observeQueueStage({ ...s.deps }, first.id, 1, 0)
  expect(await claimNext({ ...s.deps }, 'restarted-worker')).toBeNull()
  expect(
    await confirmStoppedWorker(
      s.deps,
      other,
      first.id,
      claim.job.id,
      claim.claimId
    )
  ).toMatchObject({ error: 'forbidden' })
  expect(
    await confirmStoppedWorker(
      s.deps,
      actor,
      first.id,
      claim.job.id,
      'stale-claim'
    )
  ).toMatchObject({ error: 'invalid_state' })
  expect(
    await confirmStoppedWorker(
      { ...s.deps },
      actor,
      first.id,
      claim.job.id,
      claim.claimId
    )
  ).toMatchObject({ ok: true })
  await observeQueueStage(s.deps, first.id, 1, 0)
  expect((await getJob(s.deps, claim.job.id))?.recoveredBy).toBe(actor.uid)
  expect(await claimNext(s.deps, 'restarted-worker')).not.toBeNull()
})

test('dead direct-stage jobs are visible and safely recoverable so old local APIs cannot permanently block a new queue', async () => {
  const s = setup()
  await createJob(s.deps, {
    id: 'old-direct',
    batchId: 'batch',
    plateId: 'AK.one',
    requestedBy: actor.uid,
    stage: 'describe',
  })
  const direct = (await claimNext(s.deps, 'dead-direct-worker'))!
  await s.run('waiting-after-direct')
  s.advance(11 * 60_000)
  expect(await claimNext({ ...s.deps }, 'restarted-worker')).toBeNull()
  expect(await listLocalOrphanJobs(s.deps, other)).toEqual([])
  expect(await listLocalOrphanJobs(s.deps, actor)).toMatchObject([
    { id: direct.job.id, recoveryNeededAt: s.deps.now() },
  ])
  expect(
    await recoverLocalOrphanJob(s.deps, other, direct.job.id, direct.claimId)
  ).toMatchObject({ error: 'forbidden' })
  expect(
    await recoverLocalOrphanJob(
      { ...s.deps },
      actor,
      direct.job.id,
      direct.claimId
    )
  ).toMatchObject({ ok: true })
  expect(await claimNext(s.deps, 'restarted-worker')).not.toBeNull()
  expect(await listLocalOrphanJobs(s.deps, actor)).toEqual([])
})

test('submitting a Batch cannot permanently reserve a dead managed worker; recovery writes no Batch fields and Retry stays forbidden', async () => {
  const s = setup()
  const run = await s.run('submitted-dead')
  const claim = (await claimNext(s.deps, 'dead-worker'))!
  await s.run('other-queue', ['tag'], other, 'other-batch')
  const batch = (await s.review.getBatch('batch'))!
  await s.review.commit('batch', 0, {
    batch: { ...batch, revision: 1, state: 'submitted' },
  })
  const before = await s.review.readBatch('batch')
  s.advance(11 * 60_000)
  await observeQueueStage(s.deps, run.id, 1, 0)
  expect(await claimNext(s.deps, 'replacement')).toBeNull()
  expect(
    await confirmStoppedWorker(
      s.deps,
      actor,
      run.id,
      claim.job.id,
      claim.claimId
    )
  ).toMatchObject({ ok: true })
  await observeQueueStage(s.deps, run.id, 1, 0)
  expect(await s.review.readBatch('batch')).toEqual(before)
  expect(
    await retryRun(s.deps, actor, run.id, 'retry-submitted')
  ).toMatchObject({ error: 'invalid_state' })
  expect(await claimNext(s.deps, 'replacement')).not.toBeNull()
})

test('Preview flag is immutable on the run and persisted on every materialized job', async () => {
  const s = setup()
  const input = {
    requestId: 'strict-preview',
    batchId: 'batch',
    plateIds: ['AK.one'],
    stages: ['tag' as const],
    previewOnly: true,
  }
  const created = await enqueueRun(s.deps, actor, input)
  if (!created.ok) throw Error(created.error)
  await bindQueueWorkflow(s.deps, created.value.id, 1, 'preview-workflow')
  const id = await dispatchQueueStage(
    s.deps,
    created.value.id,
    1,
    0,
    'preview-hook'
  )
  expect((await getJob(s.deps, id!))?.previewOnly).toBe(true)
  expect(
    await enqueueRun(s.deps, actor, { ...input, previewOnly: false })
  ).toMatchObject({ error: 'request_mismatch' })
})

test('fatal/exhausted Workflow failure before dispatch becomes failed and safe Retry starts a new attempt', async () => {
  const s = setup()
  const created = await enqueueRun(s.deps, actor, {
    requestId: 'fatal-before-dispatch',
    batchId: 'batch',
    plateIds: ['AK.one'],
    stages: ['tag'],
  })
  if (!created.ok) throw Error(created.error)
  await bindQueueWorkflow(s.deps, created.value.id, 1, 'fatal-workflow')
  expect(
    await recordQueueWorkflowFailure(
      s.deps,
      created.value.id,
      1,
      'fatal-workflow',
      'failed'
    )
  ).toBe(true)
  const retried = await retryRun(s.deps, actor, created.value.id, 'retry-fatal')
  expect(retried).toMatchObject({
    value: {
      status: 'queued',
      attempts: [{ status: 'failed', error: 'workflow_failed' }, { number: 2 }],
    },
  })
  expect(
    await bindQueueWorkflow(s.deps, created.value.id, 2, 'new-workflow')
  ).toBe(true)
  await dispatchQueueStage(s.deps, created.value.id, 2, 0, 'new-hook')
  expect(
    await recordQueueWorkflowFailure(
      s.deps,
      created.value.id,
      1,
      'fatal-workflow',
      'failed'
    )
  ).toBe(false)
  expect(await claimNext(s.deps, 'worker')).not.toBeNull()
})

test('fatal/exhausted Workflow failure with a live claim NEVER releases it; safe recovery then Retry remains possible', async () => {
  const s = setup()
  const run = await s.run('fatal-with-claim')
  const claim = (await claimNext(s.deps, 'worker'))!
  await s.run('waiting-after-fatal', ['tag'], other, 'other-batch')
  expect(
    await recordQueueWorkflowFailure(
      s.deps,
      run.id,
      1,
      'workflow-fatal-with-claim',
      'failed'
    )
  ).toBe(true)
  expect((await getJob(s.deps, claim.job.id))?.state).toBe('claimed')
  expect(await claimNext(s.deps, 'replacement')).toBeNull()
  expect(await retryRun(s.deps, actor, run.id, 'too-soon')).toMatchObject({
    error: 'invalid_state',
  })
  s.advance(11 * 60_000)
  await confirmStoppedWorker(s.deps, actor, run.id, claim.job.id, claim.claimId)
  await recordQueueWorkflowFailure(
    s.deps,
    run.id,
    1,
    'workflow-fatal-with-claim',
    'failed'
  )
  expect(await retryRun(s.deps, actor, run.id, 'safe-retry')).toMatchObject({
    value: { attempts: [{ status: 'failed' }, { number: 2 }] },
  })
  expect(await claimNext(s.deps, 'replacement')).not.toBeNull()
})

test('existing hosted Tag jobs retain their by-id lifecycle and never reserve local physical GPU capacity', async () => {
  const s = setup()
  expect(
    await createJob(s.deps, {
      id: 'hosted',
      batchId: 'batch',
      plateId: 'AK.one',
      requestedBy: actor.uid,
      route: 'hosted',
    })
  ).toMatchObject({ ok: true })
  expect(await claimJob(s.deps, 'hosted-worker', 'hosted')).toMatchObject({
    ok: true,
    value: { job: { state: 'claimed' } },
  })
  await s.run('physical-next')
  expect(await claimNext(s.deps, 'local-worker')).not.toBeNull()
  expect(await listLocalOrphanJobs(s.deps, actor)).toEqual([])
  expect(await expireJob(s.deps, 'hosted')).toMatchObject({
    value: { state: 'expired' },
  })
})

test('enhancement skips old workers, verifies the WebP and stores it with the completed queue job', async () => {
  const s = setup()
  s.plates[0].image = 'AK/one.webp'
  const run = await s.run('enhancement', ['enhance-image'])
  expect(run.modelId).toBeUndefined()
  expect(await claimNext(s.deps, 'previous-version-worker')).toBeNull()
  const claim = (await claimNext(s.deps, 'enhancement-worker', {
    enhanceImage: true,
  }))!
  const input = await sharp({
    create: { width: 200, height: 100, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer()
  const readImage = vi.fn(async () => input.toString('base64'))
  const result = await createEnhanceImageRunner(readImage)({
    stage: 'enhance-image',
    plate: claim.job.inputPlate!,
    options: claim.job.stageOptions,
  })
  expect(readImage).toHaveBeenCalledWith('AK/one.webp')
  expect(result.fieldSuggestion).toMatchObject({
    kind: 'enhanced-image',
    width: 400,
    height: 200,
  })
  const report = { ...base, ...result }
  const reportJob = (body: ReportInput) =>
    reportResult(
      s.deps,
      'enhancement-worker',
      claim.job.id,
      claim.claimId,
      body
    )
  expect(await reportJob({ ...report, enhancedImage: 'eA==' })).toEqual({
    ok: false,
    error: 'invalid_result',
  })
  expect(await s.deps.store.readEnhancedImage(claim.job.id)).toBeNull()
  expect(await reportJob(report)).toMatchObject({
    ok: true,
    value: { state: 'completed' },
  })
  expect(await reportJob(report)).toMatchObject({ ok: true })
  expect(
    (await s.deps.store.readEnhancedImage(claim.job.id))?.toString('base64')
  ).toBe(result.enhancedImage)
  expect(await observeQueueStage(s.deps, run.id, 1, 0)).toEqual({
    phase: 'done',
  })
  const [saved] = await listRuns(s.deps, actor).then((outcome) =>
    outcome.ok ? outcome.value : []
  )
  expect(saved).toMatchObject({
    status: 'completed',
    attempts: [{ cursor: 1 }],
  })
  expect(saved.jobs[0].result).not.toHaveProperty('enhancedImage')
  expect(await s.review.listEdits('batch')).toEqual([])
})
