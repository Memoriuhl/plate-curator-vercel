import { createHook, sleep } from 'workflow'
import { createJob, expireJob, getJob } from '../lib/jobs/jobs'
import type { PipelineStage } from '../lib/jobs/types'
import { jobsDeps } from '../lib/server/context'

export async function pipelineRun(jobId: string, batchId: string, plateId: string, requestedBy: string, stage: PipelineStage, modelId: string) {
  'use workflow'
  const result = createHook<{ jobId: string }>({ token: `pipeline:${jobId}` })
  if (!await createPipelineJob(jobId, batchId, plateId, requestedBy, stage, modelId)) return { outcome: 'not_created' as const }
  const settled = await Promise.race([result, sleep('10m').then(() => 'timeout' as const)])
  return finishPipelineJob(jobId, settled === 'timeout')
}

async function createPipelineJob(jobId: string, batchId: string, plateId: string, requestedBy: string, stage: PipelineStage, modelId: string) {
  'use step'
  const result = await createJob(jobsDeps(), { id: jobId, batchId, plateId, requestedBy, stage, modelId })
  return result.ok || result.error === 'already_exists'
}

async function finishPipelineJob(jobId: string, timedOut: boolean) {
  'use step'
  const job = timedOut ? await expireJob(jobsDeps(), jobId).then(result => result.ok ? result.value : null) : await getJob(jobsDeps(), jobId)
  return { outcome: job?.state ?? 'missing', fieldSuggestion: job?.result?.fieldSuggestion ?? null }
}
