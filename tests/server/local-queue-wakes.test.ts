import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { HookNotFoundError } from 'workflow/errors'
import type { TaggingJob } from '../../lib/jobs/types'
import {
  wakeAfterReply,
  wakeRetryMs,
  wakeSendMs,
} from '../../lib/server/local-queue'
import { POST as choose } from '../../app/api/local-pipeline/runs/[id]/choice/route'
import { POST as cancel } from '../../app/api/local-pipeline/runs/[id]/cancel/route'
import { POST as recover } from '../../app/api/local-pipeline/runs/[id]/recover/route'

const mocks = vi.hoisted(() => ({
  resume: vi.fn(),
  waitUntil: vi.fn(),
  choose: vi.fn(),
  cancel: vi.fn(),
  recover: vi.fn(),
}))
vi.mock('workflow/api', () => ({
  resumeHook: mocks.resume,
  start: vi.fn(),
  getRun: vi.fn(),
}))
vi.mock('@vercel/functions', () => ({ waitUntil: mocks.waitUntil }))
vi.mock('../../workflows/local-pipeline', () => ({
  localPipelineRun: vi.fn(),
  parallelGatewayTagRun: vi.fn(),
}))
vi.mock('../../lib/jobs/queue-engine', () => ({
  chooseQueueImage: mocks.choose,
  confirmStoppedWorker: mocks.recover,
  bindQueueWorkflow: vi.fn(),
  recordQueueWorkflowFailure: vi.fn(),
}))
vi.mock('../../lib/jobs/queue', () => ({ cancelRun: mocks.cancel }))

const job = {
  id: 'run-1-0',
  queueRunId: 'run',
  completionHook: 'local-pipeline:run:1:0',
} as TaggingJob
vi.mock('../../lib/server/context', () => ({
  currentActor: async () => ({
    ok: true,
    actor: { uid: 'editor', role: 'editor', name: null },
  }),
  jobsDeps: () => ({
    store: {
      transaction: (run: (tx: unknown) => unknown) =>
        run({ get: async (id: string) => (id === job.id ? job : null) }),
    },
  }),
}))

const params = { params: Promise.resolve({ id: 'run' }) }
const routes = {
  /** Save an image choice for the waiting find-image stage. */
  choice: () =>
    choose(
      new Request('https://example.org/api/local-pipeline/runs/run/choice', {
        method: 'POST',
        body: JSON.stringify({ jobId: job.id, candidateId: 'candidate' }),
      }),
      params
    ),
  /** Cancel the run while its current job can settle. */
  cancel: () =>
    cancel(
      new Request('https://example.org/api/local-pipeline/runs/run/cancel', {
        method: 'POST',
      }),
      params
    ),
  /** Confirm the abandoned worker stopped so the stage can retry. */
  retry: () =>
    recover(
      new Request('https://example.org/api/local-pipeline/runs/run/recover', {
        method: 'POST',
        body: JSON.stringify({
          workerStopped: true,
          jobId: job.id,
          claimId: 'claim',
        }),
      }),
      params
    ),
}

/** The background work the last request handed to `waitUntil`. */
const background = () => mocks.waitUntil.mock.lastCall?.[0] as Promise<void>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const run = { attempts: [{ jobIds: [job.id] }] }
  mocks.resume.mockReset().mockResolvedValue(undefined)
  mocks.waitUntil.mockReset()
  mocks.choose.mockReset().mockResolvedValue({ ok: true, value: run })
  mocks.cancel.mockReset().mockResolvedValue({ ok: true, value: run })
  mocks.recover.mockReset().mockResolvedValue({ ok: true, value: run })
})
afterEach(() => vi.useRealTimers())

test.each(Object.keys(routes) as (keyof typeof routes)[])(
  'the %s reply never waits for its workflow wake',
  async (name) => {
    mocks.resume.mockReturnValue(new Promise(() => {}))
    const response = await routes[name]()
    expect(response.status).toBe(200)
    expect(mocks.resume).toHaveBeenCalledExactlyOnceWith(job.completionHook, {
      jobId: job.id,
    })
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1)
  }
)

test.each(Object.keys(routes) as (keyof typeof routes)[])(
  'a refused %s wake is sent again by the server after 1, 5 and 30 seconds, with no request',
  async (name) => {
    mocks.resume.mockRejectedValue(new Error('wake refused'))
    await routes[name]()
    expect(mocks.resume).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(mocks.resume).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.resume).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.resume).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.resume).toHaveBeenCalledTimes(4)
    // The retries are bounded, and the background work ends with them.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(mocks.resume).toHaveBeenCalledTimes(4)
    await expect(background()).resolves.toBeUndefined()
    expect(mocks.resume.mock.calls).toEqual(
      Array(4).fill([job.completionHook, { jobId: job.id }])
    )
  }
)

test('the retry schedule is 1, 5 and 30 seconds', () => {
  expect(wakeRetryMs).toEqual([1_000, 5_000, 30_000])
})

test('a wake stops retrying once it is delivered', async () => {
  mocks.resume.mockRejectedValueOnce(new Error('wake refused'))
  wakeAfterReply(job)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.resume).toHaveBeenCalledTimes(2)
  await expect(background()).resolves.toBeUndefined()
})

test('a send that stalls counts as refused after its own limit, so a stalled wake is retried too', async () => {
  mocks.resume.mockReturnValueOnce(new Promise(() => {}))
  wakeAfterReply(job)
  await vi.advanceTimersByTimeAsync(wakeSendMs + 999)
  expect(mocks.resume).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(mocks.resume).toHaveBeenCalledTimes(2)
  await expect(background()).resolves.toBeUndefined()
})

test('a wake for a stage whose hook is gone is not retried', async () => {
  mocks.resume.mockRejectedValue(new HookNotFoundError(job.completionHook!))
  wakeAfterReply(job)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(mocks.resume).toHaveBeenCalledTimes(1)
})

test('a job outside a queue run has nothing to wake', () => {
  wakeAfterReply({ ...job, queueRunId: undefined })
  wakeAfterReply({ ...job, completionHook: undefined })
  expect(mocks.resume).not.toHaveBeenCalled()
  expect(mocks.waitUntil).not.toHaveBeenCalled()
})
