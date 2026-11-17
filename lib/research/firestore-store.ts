import { firestoreReviewStore } from '../review/firestore-store'
import type { Firestore } from '@google-cloud/firestore'
import type { ResearchStore, ResearchToken } from './store'
import type { ResearchJob } from './types'

export function firestoreResearchStore(db: Firestore, env: string): ResearchStore {
  const jobs = db.collection('researchJobs')
  const tokens = db.collection('researchWorkerTokens')
  return {
    env,
    transaction(run) {
      return db.runTransaction(async transaction => run({
        review: firestoreReviewStore(db, env, transaction),
        async get(id) { const record = await transaction.get(jobs.doc(id)); return record.get('env') === env ? record.data() as ResearchJob : null },
        async list(filter) {
          let query = jobs.where('env', '==', env).where('state', 'in', ['queued', 'running'])
          if (filter) query = query.where('executor', '==', filter.executor).where('deadline', '>', filter.now)
          const records = await transaction.get(query)
          return records.docs.map(record => record.data() as ResearchJob)
        },
        set(job) { if (job.env !== env) throw new Error('Research environment mismatch'); transaction.set(jobs.doc(job.id), job) },
      }))
    },
    async getToken(hash) { const record = await tokens.doc(hash).get(); return record.get('env') === env ? record.data() as ResearchToken : null },
    async setToken(token) { if (token.env !== env) throw new Error('Token environment mismatch'); await tokens.doc(token.hash).set(token) },
  }
}
