import type { HostedModelBinding } from '../lib/models/selection'
import { RetryableError, getStepMetadata, getWorkflowMetadata } from 'workflow'
import { createJob, expireJob, getJob } from '../lib/jobs/jobs'
import {
  CHUNKS_IN_FLIGHT,
  chunks,
  finalOutcomes,
  retryDelayMs,
  tagHostedChunk,
  type FinalOutcome,
} from '../lib/jobs/hosted'
import { hostedTaggingDeps, jobsDeps } from '../lib/server/context'

type Request = { jobId: string; plateId: string }

/** Create and execute the hosted tagging job, then resolve its final status. */
export async function hostedTaggingRun(
  jobId: string,
  batchId: string,
  plateId: string,
  requestedBy: string,
  modelId: string,
  binding?: HostedModelBinding
) {
  'use workflow'

  if (
    !(
      await createHostedJobs(
        batchId,
        [{ jobId, plateId }],
        requestedBy,
        modelId,
        getWorkflowMetadata().workflowRunId,
        binding
      )
    ).length
  )
    return { outcome: 'not_created' as const }
  const outcomes = await tagChunk([jobId], modelId, binding)
  return finishHosted(jobId, outcomes[jobId])
}

/**
 * Create the batch's hosted jobs and run bounded groups while retaining each plate
 * outcome.
 */
export async function batchTaggingRun(
  batchId: string,
  requests: Request[],
  requestedBy: string,
  modelId: string,
  binding?: HostedModelBinding
) {
  'use workflow'

  const created = await createHostedJobs(
    batchId,
    requests,
    requestedBy,
    modelId,
    getWorkflowMetadata().workflowRunId,
    binding
  )
  const groups = chunks(created)
  const outcomes: Record<string, FinalOutcome> = {}
  for (let i = 0; i < groups.length; i += CHUNKS_IN_FLIGHT) {
    const wave = groups.slice(i, i + CHUNKS_IN_FLIGHT)
    const settled = await Promise.allSettled(
      wave.map((group) => tagChunk(group, modelId, binding))
    )
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') Object.assign(outcomes, result.value)
      else for (const id of wave[index]) outcomes[id] = 'failed'
    })
  }
  const unfinished = Object.keys(outcomes).filter(
    (id) => outcomes[id] !== 'completed'
  )
  if (unfinished.length) await expireJobs(unfinished)
  return {
    created: created.length,
    skipped: requests.length - created.length,
    outcomes,
  }
}

/** Create hosted jobs in a step and recognize IDs already created by a retry. */
async function createHostedJobs(
  batchId: string,
  requests: Request[],
  requestedBy: string,
  modelId: string,
  workflowId: string,
  binding?: HostedModelBinding
) {
  'use step'
  const d = jobsDeps()
  const created: string[] = []
  for (const request of requests) {
    const outcome = await createJob(d, {
      id: request.jobId,
      batchId,
      plateId: request.plateId,
      requestedBy,
      route: 'hosted',
      modelId,
      ...(binding ? { hostedModel: binding } : {}),
      workflowId,
    })
    if (outcome.ok || outcome.error === 'already_exists')
      created.push(request.jobId)
  }
  return created
}

/**
 * Run a hosted tagging chunk and ask the workflow engine to retry transient outcomes
 * with backoff.
 */
async function tagChunk(
  jobIds: string[],
  modelId: string,
  binding?: HostedModelBinding
) {
  'use step'
  const { attempt, maxAttempts } = getStepMetadata()
  const result = await tagHostedChunk(
    await hostedTaggingDeps(modelId, binding),
    jobIds
  )
  const pending = Object.values(result.outcomes).includes('retry')
  if (pending && attempt < maxAttempts)
    throw new RetryableError(
      `Hosted tagging will retry ${jobIds.length} Plates`,
      { retryAfter: retryDelayMs(result, attempt) }
    )
  return finalOutcomes(result)
}
tagChunk.maxRetries = 5

/** Expire jobs left unfinished after the workflow exhausts its attempts. */
async function expireJobs(jobIds: string[]) {
  'use step'
  const d = jobsDeps()
  for (const id of jobIds) {
    const job = await getJob(d, id)
    if (job?.state === 'claimed' || job?.state === 'queued')
      await expireJob(d, id)
  }
}

/** Resolve one hosted tagging job to its final status and suggestions. */
async function finishHosted(jobId: string, outcome: FinalOutcome | undefined) {
  'use step'
  const d = jobsDeps()
  const current = await getJob(d, jobId)
  const job =
    outcome !== 'completed' &&
    (current?.state === 'claimed' || current?.state === 'queued')
      ? await expireJob(d, jobId).then((result) =>
          result.ok ? result.value : null
        )
      : current
  return {
    outcome: job?.state ?? 'missing',
    ...(job?.failure ? { error: job.failure } : {}),
    suggestions: job?.result?.suggestions ?? [],
  }
}
