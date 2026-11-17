import type { Firestore } from '@google-cloud/firestore'
import type { EditableFields, ReviewBatch } from '../review/types'
import type { PipelineRun } from './queue-types'
import type { Environment, JobsStore, TaggingJob, WorkerToken } from './types'
import { shouldWriteCapabilities, type WorkerCapabilityRecord } from './capabilities'

export function firestoreJobsStore(db: Firestore, env: Environment, reviewEnv: string = env): JobsStore {
  const jobs = db.collection('jobs')
  const tokens = db.collection('workerTokens')
  const capabilities = db.collection('localPipelineCapabilities')
  const runs = db.collection('localPipelineRuns')
  return {
    env,
    async readCapabilities(scope) {
      const doc = await capabilities.doc(`${encodeURIComponent(env)}--${scope}`).get()
      return doc.exists ? doc.data() as import('./capabilities').WorkerCapabilityRecord : null
    },
    async writeCapabilities(scope, record) {
      await db.runTransaction(async transaction => {
        const ref = capabilities.doc(`${encodeURIComponent(env)}--${scope}`)
        const previous = await transaction.get(ref)
        if (shouldWriteCapabilities(previous.exists ? previous.data() as WorkerCapabilityRecord : null, record)) transaction.set(ref, record)
      })
    },
    transaction(run) {
      return db.runTransaction(async transaction => run({
        async batch(id) {
          const doc = await transaction.get(db.collection('reviewBatches').doc(id))
          if (doc.get('env') !== reviewEnv) return null
          const value = doc.data()!
          delete value.env
          delete value.publishReservation
          return { ...value, stateOrders: value.stateOrders ?? {} } as import('../review/types').ReviewBatch
        },
        async runs() {
          const snapshot = await transaction.get(runs.where('env', '==', env))
          return snapshot.docs.map(doc => doc.data() as PipelineRun)
        },
        setRun(run) { transaction.set(runs.doc(run.id), run) },
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
          if (!batch.exists || batch.get('env') !== reviewEnv) return null
          const edit = await transaction.get(ref.collection('edits').doc(plateId))
          return { baselineVersion: batch.get('baselineVersion') as number, fields: (edit.get('fields') as EditableFields | undefined) ?? {} }
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
