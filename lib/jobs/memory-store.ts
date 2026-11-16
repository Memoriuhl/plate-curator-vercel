import type { ReviewStore } from '../review/types'
import type { Environment, JobsStore, TaggingJob, WorkerToken } from './types'

export function createMemoryJobsStore(review: ReviewStore, environment: Environment) {
  const jobs = new Map<string, TaggingJob>()
  const tokens = new Map<string, WorkerToken>()
  let pending: Promise<unknown> = Promise.resolve()
  function forEnvironment(env: Environment, scopedReview = env === environment ? review : undefined): JobsStore {
    return {
      env,
      transaction(run) {
        const next = pending.then(async () => {
          const writes = new Map<string, TaggingJob>()
          const value = await run({
            async get(id) {
              const job = jobs.get(id)
              return job?.env === env ? structuredClone(job) : null
            },
            async list() { return structuredClone([...jobs.values()].filter(job => job.env === env)) },
            async review(batchId, plateId) {
              const batch = await scopedReview?.getBatch(batchId)
              if (!batch) return null
              return { fields: (await scopedReview!.getEdit(batchId, plateId))?.fields ?? {} }
            },
            create(job) {
              if (jobs.has(job.id)) throw new Error('Job already exists')
              writes.set(job.id, structuredClone(job))
            },
            set(job) { writes.set(job.id, structuredClone(job)) },
          })
          for (const [id, job] of writes) jobs.set(id, job)
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
