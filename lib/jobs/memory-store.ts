import type { ReviewStore } from '../review/types'
import type { Environment, JobsStore, TaggingJob, WorkerToken } from './types'
import { shouldWriteCapabilities, type WorkerCapabilityRecord } from './capabilities'
import type { PipelineRun } from './queue-types'

export function createMemoryJobsStore(review: ReviewStore, environment: Environment) {
  const jobs = new Map<string, TaggingJob>()
  const tokens = new Map<string, WorkerToken>()
  const capabilities = new Map<string, WorkerCapabilityRecord>()
  const runs = new Map<string, PipelineRun>()
  let pending: Promise<unknown> = Promise.resolve()
  function forEnvironment(env: Environment, scopedReview = env === environment ? review : undefined): JobsStore {
    return {
      env,
      async readCapabilities(scope) { return structuredClone(capabilities.get(`${env}:${scope}`) ?? null) },
      async writeCapabilities(scope, record) {
        const key = `${env}:${scope}`
        if (shouldWriteCapabilities(capabilities.get(key) ?? null, record)) capabilities.set(key, structuredClone(record))
      },
      transaction(run) {
        const next = pending.then(async () => {
          const writes = new Map<string, TaggingJob>()
          const runWrites = new Map<string, PipelineRun>()
          const value = await run({
            async createDraftBatch(batch) {
              if (await scopedReview?.create(batch) !== 'ok') throw Error('Batch already exists')
            },
            async batch(id) { return await scopedReview?.getBatch(id) ?? null },
            async runs() { return structuredClone([...runs.values()].filter(run => run.env === env)) },
            async getRun(id) {
              const run = runs.get(id)
              return run?.env === env ? structuredClone(run) : null
            },
            setRun(run) { runWrites.set(run.id, structuredClone(run)) },
            async get(id) {
              const job = jobs.get(id)
              return job?.env === env ? structuredClone(job) : null
            },
            async list() { return structuredClone([...jobs.values()].filter(job => job.env === env)) },
            async review(batchId, plateId) {
              const batch = await scopedReview?.getBatch(batchId)
              if (!batch) return null
              const edit = await scopedReview!.getEdit(batchId, plateId) ?? undefined
              return { baselineVersion: batch.baselineVersion, fields: edit?.fields ?? {}, edit }
            },
            async commitDraft(...args) { return await scopedReview?.commit(...args) ?? 'revision_mismatch' },
            create(job) {
              if (jobs.has(job.id)) throw new Error('Job already exists')
              writes.set(job.id, structuredClone(job))
            },
            set(job) { writes.set(job.id, structuredClone(job)) },
          })
          for (const [id, job] of writes) jobs.set(id, job)
          for (const [id, run] of runWrites) runs.set(id, run)
          return value
        })
        pending = next.catch(() => {})
        return next
      },
      async getToken(hash) {
        const token = tokens.get(hash)
        return token?.env === env ? structuredClone(token) : null
      },
      async createToken(token) {
        if (tokens.has(token.hash)) throw new Error('Token already exists')
        tokens.set(token.hash, structuredClone(token))
      },
      async revokeToken(hash, at) {
        const token = tokens.get(hash)
        if (token?.env === env && token.revokedAt === null) tokens.set(hash, { ...token, revokedAt: at })
      },
    }
  }
  return { ...forEnvironment(environment), forEnvironment }
}
