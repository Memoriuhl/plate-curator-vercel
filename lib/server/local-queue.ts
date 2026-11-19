import { waitUntil } from '@vercel/functions'
import { getRun, resumeHook, start } from 'workflow/api'
import { HookConflictError, HookNotFoundError } from 'workflow/errors'
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

/** How long one wake send may take before it counts as refused. */
export const wakeSendMs = 10_000

/** When the server sends a refused wake again, with no request needed. */
export const wakeRetryMs: readonly number[] = [1_000, 5_000, 30_000]

/**
 * Wake the queue workflow waiting on this job, in the background. The route that
 * committed the change calls it and replies at once; the reply never waits for the
 * wake. A refused or stalled send is tried again after `wakeRetryMs`, unless the stage's
 * hook is gone. Wakes are harmless to repeat, because the workflow re-reads the stage
 * from the database on each one, and a wake that never lands is caught by the
 * workflow's own re-check.
 */
export function wakeAfterReply(job: TaggingJob) {
  if (job.completionHook && job.queueRunId)
    waitUntil(sendWake(job.completionHook, job.id))
}

async function sendWake(token: string, jobId: string) {
  for (const delay of [...wakeRetryMs, null]) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      resumeHook(token, { jobId }).then(
        () => 'delivered' as const,
        (error) =>
          HookNotFoundError.is(error) ? ('gone' as const) : ('refused' as const)
      ),
      new Promise<'refused'>((resolve) => {
        timer = setTimeout(() => resolve('refused'), wakeSendMs)
      }),
    ])
    clearTimeout(timer)
    if (outcome !== 'refused' || delay === null) return
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
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
