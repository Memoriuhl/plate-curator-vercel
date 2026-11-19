import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  localPipelineRun,
  parallelGatewayTagRun,
} from '../../../workflows/local-pipeline'

const mocks = vi.hoisted(() => ({
  bind: vi.fn(),
  dispatch: vi.fn(),
  observe: vi.fn(),
  conflict: vi.fn(),
  sleep: vi.fn(),
  wave: vi.fn(),
  tag: vi.fn(),
  expire: vi.fn(),
  next: vi.fn(),
  events: [] as string[],
}))
vi.mock('../../../lib/jobs/queue/queue-hosted', () => ({
  /** Settle hosted execution immediately so tests can isolate workflow orchestration. */
  executeHostedQueueStage: async () => 'settled',
  executeHostedQueueAttempt: mocks.tag,
}))
vi.mock('../../../lib/jobs/jobs', () => ({ expireJob: mocks.expire }))
vi.mock('../../../lib/server/context', () => ({
  /** Provide an empty jobs dependency stub because queue operations are mocked separately. */ jobsDeps:
    () => ({}),
  hostedTaggingDeps: vi.fn(),
}))
vi.mock('../../../lib/jobs/queue/queue-engine', () => ({
  bindQueueWorkflow: mocks.bind,
  dispatchQueueStage: mocks.dispatch,
  observeQueueStage: mocks.observe,
  dispatchGatewayTagWave: mocks.wave,
}))
vi.mock('workflow', () => ({
  /** Return the run ID the fixture expects to bind to the workflow attempt. */
  getWorkflowMetadata: () => ({ workflowRunId: 'workflow' }),
  /** Return a controlled workflow hook with the requested token and conflict behavior. */
  createHook: ({ token }: { token: string }) => ({
    token,
    getConflict: mocks.conflict,
    /** Satisfy hook disposal without releasing a real workflow resource. */ [Symbol.dispose]() {},
    /**
     * Provide the pending event iterator used to simulate a worker that has not
     * reported.
     */
    [Symbol.asyncIterator]: () => ({ next: mocks.next }),
  }),
  sleep: mocks.sleep,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.events = []
  mocks.bind.mockResolvedValue(true)
  mocks.conflict.mockImplementation(async () => {
    mocks.events.push('hook_registered')
    return null
  })
  mocks.dispatch.mockImplementation(async () => {
    mocks.events.push('dispatch')
    return 'job'
  })
  mocks.observe.mockResolvedValue({ phase: 'next' })
  mocks.sleep.mockResolvedValue(undefined)
  // By default no wake arrives, so the workflow's own timers decide when it looks again.
  mocks.next.mockReturnValue(new Promise(() => {}))
})

/** A wake delivered to the stage hook. */
const wake = () => Promise.resolve({ done: false, value: { jobId: 'job' } })
/** A timer that does not fire during the test. */
const pending = () => new Promise<void>(() => {})

test('each unique attempt/stage hook is registered before dispatch and completed jobs reconcile without callback', async () => {
  expect(await localPipelineRun('run', 2, 1, 3)).toEqual({
    outcome: 'completed',
  })
  expect(mocks.events).toEqual([
    'hook_registered',
    'dispatch',
    'hook_registered',
    'dispatch',
  ])
  expect(mocks.dispatch.mock.calls.map((args) => args.slice(1))).toEqual([
    ['run', 2, 1, 'local-pipeline:run:2:1'],
    ['run', 2, 2, 'local-pipeline:run:2:2'],
  ])
})

test('workflow follows persisted skips after a result and after a blocked dispatch', async () => {
  mocks.dispatch
    .mockResolvedValueOnce('job')
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce('other-job')
  mocks.observe
    .mockResolvedValueOnce({ phase: 'next', nextIndex: 2 })
    .mockResolvedValueOnce({ phase: 'next', nextIndex: 4 })
    .mockResolvedValueOnce({ phase: 'done' })

  expect(await localPipelineRun('run', 1, 0, 5)).toEqual({ outcome: 'settled' })
  expect(mocks.dispatch.mock.calls.map((args) => args[3])).toEqual([0, 2, 4])
  expect(mocks.observe.mock.calls.map((args) => args[3])).toEqual([0, 2, 4])
})

test('hook conflict or superseded coordinator cannot dispatch a job', async () => {
  mocks.conflict.mockResolvedValue({ runId: 'other' })
  expect(await localPipelineRun('run', 1, 0, 1)).toEqual({
    outcome: 'hook_conflict',
  })
  expect(mocks.dispatch).not.toHaveBeenCalled()
  mocks.bind.mockResolvedValue(false)
  expect(await localPipelineRun('run', 1, 0, 1)).toEqual({
    outcome: 'superseded',
  })
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * Durable timers on the workflow's clock. A timer fires only when it is the earliest one
 * pending and the workflow has nothing else to do, which moves the clock to its due time.
 * A timer nobody waits for any more stays pending, as it does in the runtime.
 */
function timerClock() {
  const start = Date.parse('2026-11-18T12:00:00Z')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(start)
  const timers: {
    wait: unknown
    due: number
    fired: boolean
    fire: () => void
  }[] = []
  let mostPending = 0
  const pending = () => timers.filter((timer) => !timer.fired)
  mocks.sleep.mockImplementation((wait: string | Date) => {
    const due =
      typeof wait === 'string' ? Date.now() + parseInt(wait) * 1000 : +wait
    return new Promise<void>((resolve) => {
      timers.push({ wait, due, fired: false, fire: resolve })
      mostPending = Math.max(mostPending, pending().length)
    })
  })
  return {
    pending,
    get mostPending() {
      return mostPending
    },
    waits: () => timers.map((timer) => timer.wait),
    /** Seconds after the start at which each look at the stage happened. */
    looks: [] as number[],
    at: (seconds: number) => start + seconds * 1000,
    /** Run the workflow, firing the earliest timer whenever it is idle. */
    async run(workflow: Promise<unknown>) {
      let result: unknown
      let finished = false
      void workflow.then((value) => {
        result = value
        finished = true
      })
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (finished) return result
        const [next] = pending().sort((a, b) => a.due - b.due)
        if (!next) throw new Error('the workflow waits with no timer')
        vi.setSystemTime(next.due)
        next.fired = true
        next.fire()
      }
    },
    since: start,
  }
}

/** Record when each look at the stage happened, in seconds after the clock started. */
function observeAt(clock: ReturnType<typeof timerClock>, states: unknown[]) {
  for (const state of states)
    mocks.observe.mockImplementationOnce(async () => {
      clock.looks.push((Date.now() - clock.since) / 1000)
      return state
    })
}

test('a waiting stage re-checks its own state every 90 seconds with no wake', async () => {
  const clock = timerClock()
  observeAt(clock, [
    { phase: 'waiting' },
    { phase: 'waiting' },
    { phase: 'next' },
  ])
  expect(await clock.run(localPipelineRun('run', 1, 0, 1))).toEqual({
    outcome: 'completed',
  })
  expect(clock.looks).toEqual([0, 90, 180])
  expect(clock.waits()).toEqual(['90s', '90s'])
  expect(clock.pending()).toHaveLength(0)
})

test('repeated re-checks of an unchanged lease keep one pending timer, and settling before the deadline leaves none', async () => {
  const clock = timerClock()
  // A worker holds a ten-minute lease and reports after nine minutes, with every wake lost.
  const deadline = clock.at(600)
  observeAt(clock, [
    ...Array.from({ length: 6 }, () => ({ phase: 'claimed', deadline })),
    { phase: 'next' },
  ])
  expect(await clock.run(localPipelineRun('run', 1, 0, 1))).toEqual({
    outcome: 'completed',
  })
  expect(clock.looks).toEqual([0, 90, 180, 270, 360, 450, 540])
  expect(clock.mostPending).toBe(1)
  expect(clock.pending()).toHaveLength(0)
  expect(clock.waits()).toEqual(Array(6).fill('90s'))
})

test('a lease that ends before the next re-check is the one timer, and the backstop resumes after it', async () => {
  const clock = timerClock()
  observeAt(clock, [
    { phase: 'claimed', deadline: clock.at(30) },
    // The lease ran out with no report, so the stage waits for recovery.
    { phase: 'waiting' },
    { phase: 'next' },
  ])
  expect(await clock.run(localPipelineRun('run', 1, 0, 1))).toEqual({
    outcome: 'completed',
  })
  expect(clock.looks).toEqual([0, 30, 120])
  expect(clock.waits()).toEqual([new Date(clock.at(30)), '90s'])
  expect(clock.mostPending).toBe(1)
  expect(clock.pending()).toHaveLength(0)
})

test('wakes reuse the one pending timer, so a stage that settles on a wake leaves only that timer', async () => {
  const clock = timerClock()
  const deadline = clock.at(600)
  mocks.next
    .mockReturnValueOnce(wake())
    .mockReturnValueOnce(wake())
    .mockReturnValueOnce(wake())
    .mockReturnValueOnce(wake())
  observeAt(clock, [
    { phase: 'waiting' },
    { phase: 'claimed', deadline },
    { phase: 'claimed', deadline },
    { phase: 'claimed', deadline },
    { phase: 'next' },
  ])
  expect(await clock.run(localPipelineRun('run', 1, 0, 1))).toEqual({
    outcome: 'completed',
  })
  expect(clock.looks).toEqual([0, 0, 0, 0, 0])
  // A sleep cannot be cancelled. When it fires after the run finished, the runtime
  // refuses the event and does not replay the workflow.
  expect(clock.waits()).toEqual(['90s'])
  expect(clock.pending()).toHaveLength(1)
})

test('a repeated wake only re-reads the stage', async () => {
  mocks.sleep.mockImplementation(pending)
  mocks.next.mockReturnValueOnce(wake()).mockReturnValueOnce(wake())
  mocks.observe
    .mockResolvedValueOnce({ phase: 'waiting' })
    .mockResolvedValueOnce({ phase: 'waiting' })
    .mockResolvedValueOnce({ phase: 'next' })
  expect(await localPipelineRun('run', 1, 0, 1)).toEqual({
    outcome: 'completed',
  })
  expect(mocks.dispatch).toHaveBeenCalledTimes(1)
  expect(mocks.observe).toHaveBeenCalledTimes(3)
})

test('Gateway Tag starts all available plates together and settles them in order', async () => {
  const wave = Array.from({ length: 6 }, (_, index) => ({
    id: `job-${index}`,
    index,
  }))
  mocks.wave
    .mockResolvedValueOnce(wave)
    .mockResolvedValueOnce([{ id: 'job-6', index: 6 }])
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  mocks.tag.mockImplementation(async () => {
    await barrier
    return { outcome: 'settled' }
  })
  const running = parallelGatewayTagRun('run', 1, 0, 7)
  try {
    await vi.waitFor(() => expect(mocks.tag).toHaveBeenCalledTimes(6))
    expect(mocks.observe).not.toHaveBeenCalled()
  } finally {
    release()
  }
  expect(await running).toEqual({ outcome: 'completed' })
  expect(mocks.wave.mock.calls.map((args) => args[3])).toEqual([0, 6])
  expect(mocks.observe.mock.calls.map((args) => args[3])).toEqual([
    0, 1, 2, 3, 4, 5, 6,
  ])
})

test('Gateway Tag honors provider backoff and stops retrying a single failing plate', async () => {
  mocks.wave.mockResolvedValue([{ id: 'job-0', index: 0 }])
  mocks.tag.mockResolvedValue({ outcome: 'retry', retryAfterMs: 62_000 })
  expect(await parallelGatewayTagRun('run', 1, 0, 1)).toEqual({
    outcome: 'completed',
  })
  expect(mocks.tag).toHaveBeenCalledTimes(5)
  expect(mocks.sleep.mock.calls.flat()).toEqual([
    62_000, 62_000, 62_000, 62_000,
  ])
  expect(mocks.expire).toHaveBeenCalledExactlyOnceWith({}, 'job-0')
})
