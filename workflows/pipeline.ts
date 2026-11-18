import { createHook, sleep } from 'workflow'
import { createJob, expireJob, getJob } from '../lib/jobs/jobs'
import type { PipelineStage } from '../lib/jobs/types'
import { jobsDeps } from '../lib/server/context'

/** Start a standalone pipeline job and wait for the worker report or deadline. */
export async function pipelineRun(
  jobId: string,
  batchId: string,
  plateId: string,
  requestedBy: string,
  stage: PipelineStage,
  modelId?: string
) {
  'use workflow'
  const result = createHook<{ jobId: string }>({ token: `pipeline:${jobId}` })
  if (
    !(await createPipelineJob(
      jobId,
      batchId,
      plateId,
      requestedBy,
      stage,
      modelId
    ))
  )
    return { outcome: 'not_created' as const }
  const settled = await Promise.race([
    result,
    sleep('10m').then(() => 'timeout' as const),
  ])
  return finishPipelineJob(jobId, settled === 'timeout')
}

/** Create the pipeline job in a durable step and allow safe retry of its known ID. */
async function createPipelineJob(
  jobId: string,
  batchId: string,
  plateId: string,
  requestedBy: string,
  stage: PipelineStage,
  modelId?: string
) {
  'use step'
  const result = await createJob(jobsDeps(), {
    id: jobId,
    batchId,
    plateId,
    requestedBy,
    stage,
    ...(modelId ? { modelId } : {}),
  })
  return result.ok || result.error === 'already_exists'
}

/** Read the final pipeline result, expiring the job first when its workflow timed out. */
async function finishPipelineJob(jobId: string, timedOut: boolean) {
  'use step'
  const job = timedOut
    ? await expireJob(jobsDeps(), jobId).then((result) =>
        result.ok ? result.value : null
      )
    : await getJob(jobsDeps(), jobId)
  return {
    outcome: job?.state ?? 'missing',
    fieldSuggestion: job?.result?.fieldSuggestion ?? null,
  }
}
