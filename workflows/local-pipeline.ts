import { createHook, getWorkflowMetadata, sleep } from 'workflow'
import {
  bindQueueWorkflow,
  dispatchGatewayTagWave,
  dispatchQueueStage,
  observeQueueStage,
} from '../lib/jobs/queue-engine'
import { hostedTaggingDeps, jobsDeps } from '../lib/server/context'
import { expireJob } from '../lib/jobs/jobs'
import {
  executeHostedQueueAttempt,
  executeHostedQueueStage,
} from '../lib/jobs/queue-hosted'

/**
 * Drive the queue attempt through its stages and wait for worker events, retries or
 * timeouts.
 */
export async function localPipelineRun(
  id: string,
  attempt: number,
  startIndex: number,
  stepCount: number
) {
  'use workflow'
  const { workflowRunId } = getWorkflowMetadata()
  if (!(await bind(id, attempt, workflowRunId)))
    return { outcome: 'superseded' }
  for (let index = startIndex; index < stepCount; index++) {
    using hook = createHook<{ jobId?: string }>({
      token: `local-pipeline:${id}:${attempt}:${index}`,
    })
    if (await hook.getConflict()) return { outcome: 'hook_conflict' }
    const jobId = await dispatch(id, attempt, index, hook.token)
    if (!jobId) {
      const state = await observe(id, attempt, index)
      if (state.phase !== 'next') return { outcome: 'stopped' }
      index = (state.nextIndex ?? index + 1) - 1
      continue
    }
    for (;;) {
      const hosted = await executeHosted(jobId)
      if (hosted === 'settled') break
      await sleep(hosted === 'waiting' ? '5s' : '30s')
    }
    const events = hook[Symbol.asyncIterator]()
    let event = events.next()
    for (;;) {
      const state = await observe(id, attempt, index)
      if (state.phase === 'done') return { outcome: 'settled' }
      if (state.phase === 'next') {
        index = (state.nextIndex ?? index + 1) - 1
        break
      }
      const timer =
        state.phase === 'claimed' && state.deadline
          ? sleep(new Date(state.deadline))
          : sleep('1h')
      const wake = await Promise.race([
        event.then(() => 'event' as const),
        timer.then(() => 'timer' as const),
      ])
      if (wake === 'event') event = events.next()
    }
  }
  return { outcome: 'completed' }
}

export async function parallelGatewayTagRun(
  id: string,
  attempt: number,
  startIndex: number,
  stepCount: number
) {
  'use workflow'
  if (!(await bind(id, attempt, getWorkflowMetadata().workflowRunId)))
    return { outcome: 'superseded' }

  let index = startIndex
  while (index < stepCount) {
    const wave = await prepareTagWave(id, attempt, index)
    if (!wave.length) return { outcome: 'stopped' }

    const results = await Promise.allSettled(
      wave.map((job) => finishGatewayTag(job.id))
    )
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) throw failure.reason

    for (const job of wave) {
      if (job.index < index) continue
      const state = await observe(id, attempt, job.index)
      if (state.phase === 'done') return { outcome: 'settled' }
      if (state.phase !== 'next')
        throw new Error('Gateway Tag job did not settle')
      index = state.nextIndex ?? job.index + 1
    }
  }
  return { outcome: 'completed' }
}

async function finishGatewayTag(jobId: string) {
  let retries = 0
  for (;;) {
    const { outcome, retryAfterMs } = await executeGatewayTag(jobId)
    if (outcome === 'settled') return
    if (outcome === 'waiting') await sleep('5s')
    else {
      if (++retries === 5) {
        await expireGatewayTag(jobId)
        return
      }
      await sleep(Math.max(30_000, retryAfterMs ?? 0))
    }
  }
}

async function prepareTagWave(id: string, attempt: number, index: number) {
  'use step'
  return dispatchGatewayTagWave(jobsDeps(), id, attempt, index)
}

async function executeGatewayTag(jobId: string) {
  'use step'
  return executeHostedQueueAttempt(jobsDeps(), jobId, hostedTaggingDeps)
}

async function expireGatewayTag(jobId: string) {
  'use step'
  await expireJob(jobsDeps(), jobId)
}

/** Bind the workflow runtime ID to the queue attempt in a durable step. */
async function bind(id: string, attempt: number, workflowId: string) {
  'use step'
  return bindQueueWorkflow(jobsDeps(), id, attempt, workflowId)
}

/** Create or recover the job for the next queue stage in a durable step. */
async function dispatch(
  id: string,
  attempt: number,
  index: number,
  token: string
) {
  'use step'
  return dispatchQueueStage(jobsDeps(), id, attempt, index, token)
}

/** Read and settle stage progress using the current jobs store in a durable step. */
async function observe(id: string, attempt: number, index: number) {
  'use step'
  return observeQueueStage(jobsDeps(), id, attempt, index)
}

/**
 * Run hosted stages within the workflow while using the same queue settlement contract.
 */
async function executeHosted(id: string) {
  'use step'
  return executeHostedQueueStage(
    jobsDeps(),
    id,
    hostedTaggingDeps,
    async (job) => {
      const { hostedQueueResearch } =
        await import('../lib/server/research-context')
      return hostedQueueResearch(job)
    }
  )
}
