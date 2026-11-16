import type { Firestore } from '@google-cloud/firestore'
import type { EditableFields } from '../review/types'
import type { Environment, JobsStore, TaggingJob, WorkerToken } from './types'

export function firestoreJobsStore(db: Firestore, env: Environment): JobsStore {
  const jobs = db.collection('jobs')
  const tokens = db.collection('workerTokens')
  return {
    env,
    transaction(run) {
      return db.runTransaction(async transaction => run({
        async get(id) {
          const doc = await transaction.get(jobs.doc(id))
          return doc.get('env') === env ? doc.data() as TaggingJob : null
        },
        async list() {
          const snapshot = await transaction.get(jobs.where('env', '==', env))
          return snapshot.docs.map(doc => doc.data() as TaggingJob)
        },
        async review(batchId, plateId) {
          const ref = db.collection('reviewBatches').doc(batchId)
          const batch = await transaction.get(ref)
          if (batch.get('env') !== env || !(batch.get('plateIds') as string[] | undefined)?.includes(plateId)) return null
          const edit = await transaction.get(ref.collection('edits').doc(plateId))
          return { fields: (edit.get('fields') as EditableFields | undefined) ?? {} }
        },
        create(job) { transaction.create(jobs.doc(job.id), job) },
        set(job) { transaction.set(jobs.doc(job.id), job) },
      }))
    },
    async getToken(hash) {
      const doc = await tokens.doc(hash).get()
      return doc.get('env') === env ? doc.data() as WorkerToken : null
    },
    async createToken(token) { await tokens.doc(token.hash).create(token) },
    async revokeToken(hash, at) {
      await db.runTransaction(async transaction => {
        const ref = tokens.doc(hash)
        const token = await transaction.get(ref)
        if (token.get('env') === env && token.get('revokedAt') === null) transaction.update(ref, { revokedAt: at })
      })
    },
  }
}
