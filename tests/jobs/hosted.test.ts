import { expect, test } from 'vitest'
import type { Plate } from '../../lib/catalog/types'
import {
  chunks,
  finalOutcomes,
  HOSTED_WORKER,
  retryDelayMs,
  tagHostedChunk,
  type HostedDeps,
} from '../../lib/jobs/hosted'
import { claimNext, createJob, getJob } from '../../lib/jobs/jobs'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import type { JobsDeps } from '../../lib/jobs/types'
import { createMemoryStore } from '../../lib/review/memory-store'
import { plateRevision } from '../../lib/review/draft/revision'
import { retryAfterMs, type ModelAdapter } from '../../worker/model'

/**
 * Create an in-memory hosted tagging fixture with controlled inputs, images and lease
 * time.
 */
async function setup(suggest: ModelAdapter['suggest'], plateIds = ['one']) {
  const review = createMemoryStore([])
  await review.create({
    stateOrders: {},
    id: 'batch',
    name: 'Batch',
    createdBy: 'owner',
    createdByName: null,
    createdAt: '2026-11-15T12:00:00Z',
    state: 'open',
    revision: 0,
    baselineVersion: 1,
    plateIds,
    approval: null,
  })
  let time = 1000
  let sequence = 0
  /** Build a minimal image-backed California plate for the hosted model fixture. */
  const plate = (id: string): Plate => ({
    id,
    state: 'CA',
    slug: id,
    displayName: id,
    image: `${id}.webp`,
    tags: [],
  })
  const jobs: JobsDeps = {
    store: createMemoryJobsStore(review, 'development'),
    /** Provide the baseline plate data used by the review or job scenario. */ baseline:
      async (id) => plate(id),
    /** Read the controlled test clock so state and lease timestamps advance deterministically. */ now: () =>
      time,
    /** Issue deterministic IDs in allocation order so the test can address each generated record. */ id: () =>
      `id-${++sequence}`,
    leaseMs: 100,
  }
  const images: Record<string, string | null | Error> = {}
  const calls: string[] = []
  const deps: HostedDeps = {
    jobs,
    adapter: {
      backend: 'hosted',
      model: 'test/model',
      promptVersion: 'v1',
      /** Record the plate name before calling the injected model response for this attempt. */ suggest:
        async (input) => {
          calls.push(input.plate.displayName)
          return suggest(input)
        },
    },
    /** Resolve the model input from the current fixture job's plate ID. */
    plate: async (job) => ({ ...plate(job.plateId) }),
    /** Supply each plate's fixture image or simulate the configured image failure. */
    image: async (p) => {
      const image = images[p.id]
      if (image instanceof Error) throw image
      return image === undefined ? 'aW1hZ2U=' : image
    },
  }
  for (const id of plateIds)
    await createJob(jobs, {
      id: `job-${id}`,
      batchId: 'batch',
      plateId: id,
      requestedBy: 'requester',
      route: 'hosted',
    })
  return {
    deps,
    jobs,
    review,
    images,
    calls,
    /** Move the test clock forward so deadlines can be reached without waiting. */ advance:
      (ms: number) => {
        time += ms
      },
  }
}

/** Return a successful hosted model suggestion with predictable token usage. */
const ok: ModelAdapter['suggest'] = async () => ({
  tags: ['Bear'],
  usage: { tokens: 3 },
})
/**
 * Produce a retryable rate-limit failure with the provider delay selected by the test.
 */
const rateLimited = (retryAfter?: number) =>
  Object.assign(new Error('Model request failed: 429'), {
    status: 429,
    retryAfterMs: retryAfter,
  })

test('a chunk tags every Plate and completes the jobs through the report path', async () => {
  const s = await setup(ok, ['one', 'two'])
  const result = await tagHostedChunk(s.deps, ['job-one', 'job-two'])
  expect(result).toEqual({
    outcomes: { 'job-one': 'completed', 'job-two': 'completed' },
    retryAfterMs: null,
  })
  expect(await getJob(s.jobs, 'job-one')).toMatchObject({
    state: 'completed',
    workerId: HOSTED_WORKER,
    result: {
      suggestions: ['bear'],
      backend: 'hosted',
      model: 'test/model',
      usage: { tokens: 3 },
    },
  })
})

test('one rate-limited Plate leaves the others completed and a retry redoes only that Plate', async () => {
  let limited = true
  const s = await setup(
    async (input) => {
      if (input.plate.displayName === 'two' && limited)
        throw rateLimited(45_000)
      return ok(input)
    },
    ['one', 'two', 'three']
  )
  const first = await tagHostedChunk(s.deps, [
    'job-one',
    'job-two',
    'job-three',
  ])
  expect(first).toEqual({
    outcomes: {
      'job-one': 'completed',
      'job-two': 'retry',
      'job-three': 'completed',
    },
    retryAfterMs: 45_000,
  })
  expect(retryDelayMs(first, 1)).toBe(45_000)
  limited = false
  s.calls.length = 0
  const second = await tagHostedChunk(s.deps, [
    'job-one',
    'job-two',
    'job-three',
  ])
  expect(second.outcomes).toEqual({
    'job-one': 'completed',
    'job-two': 'completed',
    'job-three': 'completed',
  })
  expect(s.calls).toEqual(['two'])
})

test('a retry waits for the larger of Retry-After and exponential backoff', () => {
  expect(retryDelayMs({ outcomes: {}, retryAfterMs: null }, 1)).toBe(20_000)
  expect(retryDelayMs({ outcomes: {}, retryAfterMs: 5_000 }, 3)).toBe(80_000)
})

test('transient errors retry and permanent errors fail', async () => {
  const s = await setup(
    async (input) => {
      if (input.plate.displayName === 'one')
        throw Object.assign(new Error('Model request failed: 503'), {
          status: 503,
        })
      if (input.plate.displayName === 'two')
        throw Object.assign(new Error('Model request failed: 400'), {
          status: 400,
        })
      throw new Error('socket hang up')
    },
    ['one', 'two', 'three']
  )
  const result = await tagHostedChunk(s.deps, [
    'job-one',
    'job-two',
    'job-three',
  ])
  expect(result.outcomes).toEqual({
    'job-one': 'retry',
    'job-two': 'failed',
    'job-three': 'retry',
  })
  expect(finalOutcomes(result)).toEqual({
    'job-one': 'failed',
    'job-two': 'failed',
    'job-three': 'failed',
  })
})

test('a missing image completes with no suggestions and an image error follows its status', async () => {
  const s = await setup(ok, ['one', 'two', 'three'])
  s.images.one = null
  s.images.two = Object.assign(new Error('Image request failed: 403'), {
    status: 403,
  })
  s.images.three = Object.assign(new Error('Image request failed: 502'), {
    status: 502,
  })
  const result = await tagHostedChunk(s.deps, [
    'job-one',
    'job-two',
    'job-three',
  ])
  expect(result.outcomes).toEqual({
    'job-one': 'completed',
    'job-two': 'failed',
    'job-three': 'retry',
  })
  expect(await getJob(s.jobs, 'job-one')).toMatchObject({
    result: { suggestions: [], backend: 'missing-image' },
  })
  expect(s.calls).toEqual([])
})

test('a Plate edited while tagging runs is reported stale', async () => {
  const s = await setup(async (input) => {
    const batch = await s.review.getBatch('batch')
    await s.review.commit('batch', 0, {
      batch: { ...batch!, revision: 1 },
      edit: {
        plateId: 'one',
        baseRevision: plateRevision(input.plate as Plate),
        fields: { tags: ['edited'] },
        authorId: 'owner',
        updatedAt: 'now',
        resultRevision: 'changed',
      },
    })
    return ok(input)
  })
  expect((await tagHostedChunk(s.deps, ['job-one'])).outcomes).toEqual({
    'job-one': 'stale',
  })
})

test('hosted jobs never reach the desktop queue', async () => {
  const s = await setup(ok, ['one', 'two'])
  expect(await claimNext(s.jobs, 'desktop')).toBeNull()
})

test('an unknown job fails without a model call', async () => {
  const s = await setup(ok)
  const result = await tagHostedChunk(s.deps, ['missing'])
  expect(result.outcomes).toEqual({ missing: 'failed' })
  expect(s.calls).toEqual([])
})

test('chunks split work into fixed-size groups', () => {
  expect(chunks([1, 2, 3, 4, 5, 6, 7], 5)).toEqual([
    [1, 2, 3, 4, 5],
    [6, 7],
  ])
  expect(chunks([], 5)).toEqual([])
})

test('Retry-After parses seconds and HTTP dates', () => {
  expect(retryAfterMs('30')).toBe(30_000)
  expect(
    retryAfterMs(
      'Wed, 18 Nov 2026 00:00:30 GMT',
      Date.parse('Wed, 18 Nov 2026 00:00:00 GMT')
    )
  ).toBe(30_000)
  expect(retryAfterMs(null)).toBeUndefined()
  expect(retryAfterMs('soon')).toBeUndefined()
})
