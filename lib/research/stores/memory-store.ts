import type { ResearchJob } from '../types'
import type { ResearchStore, ResearchToken } from './store'

/**
 * Provide an in-memory research store for deterministic tests with environment
 * isolation.
 */
export function createMemoryResearchStore(env = 'development') {
  const jobs = new Map<string, ResearchJob>()
  const tokens = new Map<string, ResearchToken>()
  let pending = Promise.resolve()
  /** Create an environment-scoped view over the same research job and token records. */
  const scoped = (
    env: string
  ): ResearchStore & { forEnvironment(env: string): ResearchStore } => ({
    env,
    forEnvironment: scoped,
    /**
     * Serialize transactions and publish staged research job writes only after the
     * callback succeeds.
     */
    async transaction(run, review) {
      let release!: () => void
      const previous = pending
      pending = new Promise((resolve) => {
        release = resolve
      })
      await previous
      const writes = new Map<string, ResearchJob>()
      try {
        const result = await run({
          review,
          /**
           * Read the latest job snapshot within the current environment, including
           * staged writes.
           */
          async get(id) {
            const job = writes.get(id) ?? jobs.get(id)
            return job?.env === env ? structuredClone(job) : null
          },
          /**
           * List copies of jobs matching the requested environment, state and deadline.
           */
          async list(filter) {
            return structuredClone(
              [...jobs.values()].filter(
                (job) =>
                  job.env === env &&
                  ['queued', 'running'].includes(job.state) &&
                  (!filter ||
                    (job.executor === filter.executor &&
                      job.deadline > filter.now))
              )
            )
          },
          /** Stage a job update after checking its environment matches this store. */
          set(job) {
            if (job.env !== env)
              throw new Error('Research environment mismatch')
            writes.set(job.id, structuredClone(job))
          },
        })
        for (const [id, job] of writes) jobs.set(id, job)
        return result
      } finally {
        release()
      }
    },
    /** Read a detached token record only when it belongs to this environment. */
    async getToken(hash) {
      const token = tokens.get(hash)
      return token?.env === env ? structuredClone(token) : null
    },
    /** Store a copy of the token after checking its environment. */
    async setToken(token) {
      if (token.env !== env) throw new Error('Token environment mismatch')
      tokens.set(token.hash, structuredClone(token))
    },
  })
  return scoped(env)
}
