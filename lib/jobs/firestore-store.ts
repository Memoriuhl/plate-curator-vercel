import { canQueueDuringPublish } from '../publish/pipeline-gate'
import type { Firestore } from '@google-cloud/firestore'
import { firestoreMemberByUid } from '../members/firestore-store'
import type { EditableFields, ProposedEdit } from '../review/types'
import { firestoreReviewStore } from '../review/firestore-store'
import type { PipelineRun } from './queue-types'
import type { Environment, JobsStore, TaggingJob, WorkerToken } from './types'
import { shouldWriteCapabilities, type WorkerCapabilityRecord } from './capabilities'
import { liveEnvKey, signalPath } from '../review/live-signal'

export function firestoreJobsStore(db: Firestore, env: Environment, reviewEnv: string = env): JobsStore {
  const jobs = db.collection('jobs')
  const enhancedImages = db.collection('localPipelineEnhancedImages')
  const tokens = db.collection('workerTokens')
  const capabilities = db.collection('localPipelineCapabilities')
  const runs = db.collection('localPipelineRuns')
  return {
    env,
    async readEnhancedImage(id) {
      const doc = await enhancedImages.doc(id).get()
      const bytes: unknown = doc.get('bytes')
      return doc.get('env') === env && Buffer.isBuffer(bytes) ? bytes : null
    },
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
        canQueue: () => canQueueDuringPublish(db, transaction, reviewEnv),
        async createDraftBatch(batch) {
          transaction.create(db.collection('reviewBatches').doc(batch.id), { ...batch, env: reviewEnv })
          transaction.set(db.doc(signalPath(liveEnvKey(reviewEnv), batch.id)), { revision: batch.revision })
        },
        async reviewFields(batchId, plateIds) {
          const edits = db.collection('reviewBatches').doc(batchId).collection('edits')
          const fields = new Map<string, EditableFields>()
          for (let offset = 0; offset < plateIds.length; offset += 100) {
            const snapshots = await transaction.getAll(...plateIds.slice(offset, offset + 100).map(id => edits.doc(id)))
            for (const snapshot of snapshots) if (snapshot.exists) fields.set(snapshot.id, snapshot.get('fields') as EditableFields)
          }
          return fields
        },
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
        async getRun(id) {
          if (!id || id.includes('/')) return null
          const doc = await transaction.get(runs.doc(id))
          return doc.get('env') === env ? doc.data() as PipelineRun : null
        },
        setRun(run) { transaction.set(runs.doc(run.id), run) },
        async get(id) {
          const doc = await transaction.get(jobs.doc(id))
          return doc.get('env') === env ? doc.data() as TaggingJob : null
        },
        async list(plateId) {
          const scoped = jobs.where('env', '==', env)
          const snapshot = await transaction.get(plateId ? scoped.where('plateId', '==', plateId) : scoped)
          return snapshot.docs.map(doc => doc.data() as TaggingJob)
        },
        async review(batchId, plateId) {
          const ref = db.collection('reviewBatches').doc(batchId)
          const batch = await transaction.get(ref)
          if (!batch.exists || batch.get('env') !== reviewEnv) return null
          const snapshot = await transaction.get(ref.collection('edits').doc(plateId))
          const edit = snapshot.data() as ProposedEdit | undefined
          return { baselineVersion: batch.get('baselineVersion') as number, fields: edit?.fields ?? {}, edit }
        },
        async pipelineRequesterRole(uid) {
          const member = await firestoreMemberByUid(db, uid, transaction)
          return member?.uid === uid && member.status === 'active' ? member.role : null
        },
        commitDraft: firestoreReviewStore(db, reviewEnv, transaction).commit,
        create(job) { transaction.create(jobs.doc(job.id), job) },
        set(job) { transaction.set(jobs.doc(job.id), job) },
        setEnhancedImage(id, bytes) { transaction.create(enhancedImages.doc(id), { bytes, env }) },
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
