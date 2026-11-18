import type { ResearchJob } from './types'
import type { ResearchStore, ResearchToken } from './store'

export function createMemoryResearchStore(env = 'development') {
  const jobs = new Map<string, ResearchJob>()
  const tokens = new Map<string, ResearchToken>()
  let pending = Promise.resolve()
  const scoped = (env: string): ResearchStore & { forEnvironment(env: string): ResearchStore } => ({
    env,
    forEnvironment: scoped,
    async transaction(run, review) {
      let release!: () => void
      const previous = pending
      pending = new Promise(resolve => { release = resolve })
      await previous
      const writes = new Map<string, ResearchJob>()
      try {
        const result = await run({
          review,
          async get(id) { const job = writes.get(id) ?? jobs.get(id); return job?.env === env ? structuredClone(job) : null },
          async list(filter) { return structuredClone([...jobs.values()].filter(job => job.env === env && ['queued', 'running'].includes(job.state) && (!filter || job.executor === filter.executor && job.deadline > filter.now))) },
          set(job) { if (job.env !== env) throw new Error('Research environment mismatch'); writes.set(job.id, structuredClone(job)) },
        })
        for (const [id, job] of writes) jobs.set(id, job)
        return result
      } finally { release() }
    },
    async getToken(hash) { const token = tokens.get(hash); return token?.env === env ? structuredClone(token) : null },
    async setToken(token) { if (token.env !== env) throw new Error('Token environment mismatch'); tokens.set(token.hash, structuredClone(token)) },
  })
  return scoped(env)
}
