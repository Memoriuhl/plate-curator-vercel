import { createHook, sleep } from 'workflow'
import { createJob, expireJob, getJob } from '../lib/jobs/jobs'
import { jobsDeps } from '../lib/server/context'

/** Start a tagging job and resolve its workflow after the report or timeout. */
export async function taggingRun(
  jobId: string,
  batchId: string,
  plateId: string,
  requestedBy: string,
  modelId?: string
) {
  'use workflow'

  const result = createHook<{ jobId: string }>({ token: `tagging:${jobId}` })
  if (!(await createTaggingJob(jobId, batchId, plateId, requestedBy, modelId)))
    return { outcome: 'not_created' as const }

  const settled = await Promise.race([
    result,
    sleep('10m').then(() => 'timeout' as const),
  ])
  return finishTagging(jobId, settled === 'timeout')
}

/**
 * Create a tagging job in a durable step and treat an existing ID as a successful retry.
 */
async function createTaggingJob(
  jobId: string,
  batchId: string,
  plateId: string,
  requestedBy: string,
  modelId?: string
) {
  'use step'
  const outcome = await createJob(jobsDeps(), {
    id: jobId,
    batchId,
    plateId,
    requestedBy,
    ...(modelId ? { modelId } : {}),
  })
  return outcome.ok || outcome.error === 'already_exists'
}

/** Return the completed tagging suggestions or expire the waiting job after timeout. */
async function finishTagging(jobId: string, timedOut: boolean) {
  'use step'
  const job = timedOut
    ? await expireJob(jobsDeps(), jobId).then((outcome) =>
        outcome.ok ? outcome.value : null
      )
    : await getJob(jobsDeps(), jobId)
  return {
    outcome: job?.state ?? 'missing',
    suggestions: job?.result?.suggestions ?? [],
  }
}
