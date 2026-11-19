import {
  firestoreReviewStore,
  reviewTransaction,
} from '../../review/firestore-store'
import type { Firestore } from '@google-cloud/firestore'
import { signalChange } from '../../live/change-signals'
import type { ResearchStore, ResearchToken } from './store'
import type { ResearchJob } from '../types'

/** Build a research jobs and tokens adapter scoped to the selected environment. */
export function firestoreResearchStore(
  db: Firestore,
  env: string
): ResearchStore {
  const jobs = db.collection('researchJobs')
  const tokens = db.collection('researchWorkerTokens')
  return {
    env,
    /**
     * Run research job updates in a Firestore transaction and share its review context
     * when supplied. After a transaction that changed a job, tell research listeners.
     */
    async transaction(run) {
      const transact = reviewTransaction(db, env)
      let wrote = false
      const result = await transact(async (transaction, touch) => {
        wrote = false
        return run({
          review: firestoreReviewStore(db, env, transaction, touch),
          /** Read a research job only when it belongs to the adapter's environment. */
          async get(id) {
            const record = await transaction.get(jobs.doc(id))
            return record.get('env') === env
              ? (record.data() as ResearchJob)
              : null
          },
          /**
           * Query research jobs in this environment with optional state and lease filters.
           */
          async list(filter) {
            let query = jobs
              .where('env', '==', env)
              .where('state', 'in', ['queued', 'running'])
            if (filter)
              query = query
                .where('executor', '==', filter.executor)
                .where('deadline', '>', filter.now)
            const records = await transaction.get(query)
            return records.docs.map((record) => record.data() as ResearchJob)
          },
          /**
           * Stage a research job write after checking that it remains in the current
           * environment.
           */
          set(job) {
            if (job.env !== env)
              throw new Error('Research environment mismatch')
            wrote = true
            transaction.set(jobs.doc(job.id), job)
          },
        })
      })
      if (wrote) signalChange(db, env, 'research')
      return result
    },
    /** Read a worker token by hash within the adapter's environment. */
    async getToken(hash) {
      const record = await tokens.doc(hash).get()
      return record.get('env') === env ? (record.data() as ResearchToken) : null
    },
    /** Persist a worker credential only in the environment it was issued for. */
    async setToken(token) {
      if (token.env !== env) throw new Error('Token environment mismatch')
      await tokens.doc(token.hash).set(token)
    },
  }
}
