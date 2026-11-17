import { RetryableError, getStepMetadata } from 'workflow'
import { createJob, expireJob, getJob } from '../lib/jobs/jobs'
import { CHUNKS_IN_FLIGHT, chunks, finalOutcomes, retryDelayMs, tagHostedChunk, type FinalOutcome } from '../lib/jobs/hosted'
import { hostedTaggingDeps, jobsDeps } from '../lib/server/context'

type Request = { jobId: string; plateId: string }

export async function hostedTaggingRun(jobId: string, batchId: string, plateId: string, requestedBy: string, modelId: string) {
  'use workflow'

  if (!(await createHostedJobs(batchId, [{ jobId, plateId }], requestedBy, modelId)).length) return { outcome: 'not_created' as const }
  const outcomes = await tagChunk([jobId], modelId)
  return finishHosted(jobId, outcomes[jobId])
}

export async function batchTaggingRun(batchId: string, requests: Request[], requestedBy: string, modelId: string) {
  'use workflow'

  const created = await createHostedJobs(batchId, requests, requestedBy, modelId)
  const groups = chunks(created)
  const outcomes: Record<string, FinalOutcome> = {}
  for (let i = 0; i < groups.length; i += CHUNKS_IN_FLIGHT) {
    const wave = groups.slice(i, i + CHUNKS_IN_FLIGHT)
    const settled = await Promise.allSettled(wave.map(group => tagChunk(group, modelId)))
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') Object.assign(outcomes, result.value)
      else for (const id of wave[index]) outcomes[id] = 'failed'
    })
  }
  const unfinished = Object.keys(outcomes).filter(id => outcomes[id] !== 'completed')
  if (unfinished.length) await expireJobs(unfinished)
  return { created: created.length, skipped: requests.length - created.length, outcomes }
}

async function createHostedJobs(batchId: string, requests: Request[], requestedBy: string, modelId: string) {
  'use step'
  const d = jobsDeps()
  const created: string[] = []
  for (const request of requests) {
    const outcome = await createJob(d, { id: request.jobId, batchId, plateId: request.plateId, requestedBy, route: 'hosted', modelId })
    if (outcome.ok || outcome.error === 'already_exists') created.push(request.jobId)
  }
  return created
}

async function tagChunk(jobIds: string[], modelId: string) {
  'use step'
  const { attempt, maxAttempts } = getStepMetadata()
  const result = await tagHostedChunk(await hostedTaggingDeps(modelId), jobIds)
  const pending = Object.values(result.outcomes).includes('retry')
  if (pending && attempt < maxAttempts) throw new RetryableError(`Hosted tagging will retry ${jobIds.length} Plates`, { retryAfter: retryDelayMs(result, attempt) })
  return finalOutcomes(result)
}
tagChunk.maxRetries = 5

async function expireJobs(jobIds: string[]) {
  'use step'
  const d = jobsDeps()
  for (const id of jobIds) await expireJob(d, id)
}

async function finishHosted(jobId: string, outcome: FinalOutcome | undefined) {
  'use step'
  const d = jobsDeps()
  const job = outcome !== 'completed' ? await expireJob(d, jobId).then(result => (result.ok ? result.value : null)) : await getJob(d, jobId)
  return { outcome: job?.state ?? 'missing', suggestions: job?.result?.suggestions ?? [] }
}
