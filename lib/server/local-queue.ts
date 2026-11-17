import { resumeHook, start } from 'workflow/api'
import { HookConflictError } from 'workflow/errors'
import { localPipelineRun } from '../../workflows/local-pipeline'
import { bindQueueWorkflow } from '../jobs/queue-engine'
import type { PipelineRun, QueueOutcome } from '../jobs/queue-types'
import type { TaggingJob } from '../jobs/types'
import { jobsDeps } from './context'
import { json } from './respond'

export function queueResponse<T>(outcome: QueueOutcome<T>, status = 200) {
  const codes = { forbidden: 403, not_found: 404, invalid_state: 422, bad_request: 400, request_mismatch: 409, stale_input: 409, payload_too_large: 413, attempt_limit: 422 }
  return outcome.ok ? json({ run: outcome.value }, status) : json({ error: outcome.error }, codes[outcome.error])
}

export async function startQueueWorkflow(run: PipelineRun) {
  const attempt = run.attempts.at(-1)!
  if (attempt.workflowId || !['queued', 'running'].includes(run.status)) return
  let workflowId: string
  try {
    const workflow = await start(localPipelineRun, [run.id, attempt.number, attempt.cursor, attempt.steps.length], {
      experimental_hook: { token: `local-pipeline-start:${run.localScope}:${run.id}:${attempt.number}`, experimental_minRetention: '7d' },
    })
    workflowId = workflow.runId
  } catch (error) {
    if (!HookConflictError.is(error) || !error.conflictingRunId) throw error
    workflowId = error.conflictingRunId
  }
  await bindQueueWorkflow(jobsDeps(), run.id, attempt.number, workflowId)
}

export async function wakeLocalJob(job: TaggingJob) {
  if (job.completionHook && job.queueRunId) await resumeHook(job.completionHook, { jobId: job.id }).catch(() => undefined)
}
