import { waitUntil } from '@vercel/functions'
import { getRun, resumeHook, start } from 'workflow/api'
import { HookConflictError } from 'workflow/errors'
import {
  localPipelineRun,
  parallelGatewayTagRun,
} from '../../workflows/local-pipeline'
import {
  bindQueueWorkflow,
  recordQueueWorkflowFailure,
} from '../jobs/queue-engine'
import type { PipelineRun, QueueOutcome } from '../jobs/queue-types'
import type { TaggingJob } from '../jobs/types'
import { getJob } from '../jobs/jobs'
import { wakeKey } from '../jobs/wake-ledger'
import { jobsDeps } from './context'
import { json } from './respond'

/** Map a local queue result to the HTTP response expected by dashboard actions. */
export function queueResponse<T>(outcome: QueueOutcome<T>, status = 200) {
  const codes = {
    forbidden: 403,
    not_found: 404,
    invalid_state: 422,
    unavailable: 422,
    bad_request: 400,
    request_mismatch: 409,
    stale_input: 409,
    payload_too_large: 413,
    attempt_limit: 422,
    publish_in_progress: 409,
  }
  return outcome.ok
    ? json({ run: outcome.value }, status)
    : json({ error: outcome.error }, codes[outcome.error])
}

/**
 * Start the active attempt's workflow and persist its run ID while handling an existing
 * start hook.
 */
export async function startQueueWorkflow(run: PipelineRun) {
  const attempt = run.attempts.at(-1)!
  if (attempt.workflowId || !['queued', 'running'].includes(run.status)) return
  let workflowId: string
  try {
    const workflow = await start(
      attempt.parallelTag ? parallelGatewayTagRun : localPipelineRun,
      [run.id, attempt.number, attempt.cursor, attempt.steps.length],
      {
        experimental_hook: {
          token: `local-pipeline-start:${run.localScope}:${run.id}:${attempt.number}`,
          experimental_minRetention: '7d',
        },
      }
    )
    workflowId = workflow.runId
  } catch (error) {
    if (!HookConflictError.is(error) || !error.conflictingRunId) throw error
    workflowId = error.conflictingRunId
  }
  await bindQueueWorkflow(jobsDeps(), run.id, attempt.number, workflowId)
}

/** Notify the waiting queue workflow, for a change that is not a job transition. */
export async function wakeLocalJob(job: TaggingJob) {
  if (job.completionHook && job.queueRunId)
    await resumeHook(job.completionHook, { jobId: job.id }).catch(
      () => undefined
    )
}

/** How long a sender holds a wake before another sender may take it over. */
export const wakeHoldMs = 15_000

/** When the server tries a failed wake again, with no request needed. */
export const wakeRetryMs: readonly number[] = [1_000, 5_000]

/**
 * Wake the waiting queue workflow once for the job's latest transition. The claim,
 * report and fail routes call it right after the change, and the pipeline list calls
 * it as a watchdog. The wake ledger lets one of them send it and makes the others skip;
 * a failed send is recorded, so the next caller takes it over at once, and the server
 * tries again itself after `wakeRetryMs`.
 */
export async function wakeForTransition(
  job: TaggingJob,
  retries: readonly number[] = wakeRetryMs
): Promise<void> {
  if (!job.completionHook || !job.queueRunId) return
  const deps = jobsDeps()
  const { claimWake, settleWake } = deps.store
  if (!claimWake || !settleWake) return wakeLocalJob(job)
  const runId = job.queueRunId
  const key = wakeKey(job)
  // If the ledger cannot be read, send anyway: a repeated wake is cheaper than a lost one.
  const mine = await claimWake
    .call(deps.store, runId, key, deps.now(), wakeHoldMs)
    .catch(() => true)
  if (!mine) return
  const delivered = await resumeHook(job.completionHook, {
    jobId: job.id,
  }).then(
    () => true,
    () => false
  )
  await settleWake
    .call(deps.store, runId, key, delivered)
    .catch(() => undefined)
  if (delivered || !retries.length) return
  const [delay, ...later] = retries
  waitUntil(
    new Promise((resolve) => setTimeout(resolve, delay))
      .then(async () => {
        // A newer transition brings its own wake; an older one must not overwrite it.
        const latest = await getJob(jobsDeps(), job.id)
        if (latest && wakeKey(latest) === key)
          await wakeForTransition(latest, later)
      })
      .catch(() => undefined)
  )
}

/** Check a run's linked workflow and reconcile terminal status into the queue attempt. */
export async function reconcileQueueWorkflow(run: PipelineRun) {
  const attempt = run.attempts.at(-1)!
  if (!attempt.workflowId || !['queued', 'running'].includes(run.status))
    return false
  const status = await getRun(attempt.workflowId).status
  return status === 'failed' || status === 'cancelled' || status === 'completed'
    ? recordQueueWorkflowFailure(
        jobsDeps(),
        run.id,
        attempt.number,
        attempt.workflowId,
        status
      )
    : false
}
