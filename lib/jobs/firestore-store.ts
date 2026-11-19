import { canQueueDuringPublish } from '../publish/pipeline-gate'
import {
  FieldPath,
  type Firestore,
  type Query,
  type QueryDocumentSnapshot,
  type Transaction,
} from '@google-cloud/firestore'
import { firestoreMemberByUid } from '../members/firestore-store'
import type { EditableFields, ProposedEdit } from '../review/types'
import {
  firestoreReviewStore,
  reviewTransaction,
} from '../review/firestore-store'
import type { PipelineRun } from './queue-types'
import type { Environment, JobsStore, TaggingJob, WorkerToken } from './types'
import {
  capabilitiesVisiblyChanged,
  shouldWriteCapabilities,
  type WorkerCapabilityRecord,
} from './capabilities'
import { liveEnvKey, signalPath } from '../review/live-signal'
import { signalChange } from '../live/change-signals'
import { compareJobAge, isStandaloneDesktopJob } from './claim-eligibility'

const claimPageSize = 16

async function* readClaimJobs(transaction: Transaction, query: Query) {
  let cursor: QueryDocumentSnapshot | undefined
  while (true) {
    const page = await transaction.get(
      (cursor ? query.startAfter(cursor) : query).limit(claimPageSize)
    )
    for (const document of page.docs) yield document.data() as TaggingJob
    if (page.size < claimPageSize) return
    cursor = page.docs.at(-1)
  }
}

async function oldestDesktopJob(
  transaction: Transaction,
  query: Query,
  localScope?: string
) {
  let oldest: TaggingJob | null = null
  for await (const job of readClaimJobs(transaction, query)) {
    if (oldest && job.createdAt > oldest.createdAt) break
    // A missing route still means desktop. Finish reading timestamp ties to keep the existing ID order.
    if (
      isStandaloneDesktopJob(job, localScope) &&
      (!oldest || compareJobAge(job, oldest) < 0)
    )
      oldest = job
  }
  return oldest
}

/**
 * Build the Firestore jobs adapter for one environment so queue and review writes can
 * share a transaction.
 */
export function firestoreJobsStore(
  db: Firestore,
  env: Environment,
  reviewEnv: string = env
): JobsStore {
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
    /** Read the heartbeat for this environment and worker scope. */
    async readCapabilities(scope) {
      const doc = await capabilities
        .doc(`${encodeURIComponent(env)}--${scope}`)
        .get()
      return doc.exists
        ? (doc.data() as import('./capabilities').WorkerCapabilityRecord)
        : null
    },
    /**
     * Store a heartbeat transactionally when its contents or refresh deadline have
     * changed.
     */
    async writeCapabilities(scope, record) {
      const changed = await db.runTransaction(async (transaction) => {
        const ref = capabilities.doc(`${encodeURIComponent(env)}--${scope}`)
        const snapshot = await transaction.get(ref)
        const previous = snapshot.exists
          ? (snapshot.data() as WorkerCapabilityRecord)
          : null
        if (!shouldWriteCapabilities(previous, record)) return false
        transaction.set(ref, record)
        return capabilitiesVisiblyChanged(previous, record)
      })
      if (changed) signalChange(db, reviewEnv, 'pipeline')
    },
    /**
     * Run an operation against a single Firestore transaction so queue and review
     * updates commit together. After a transaction that wrote, tell pipeline listeners,
     * and Gateway listeners too when it wrote a hosted job.
     */
    async transaction(run) {
      const transact = reviewTransaction(db, reviewEnv)
      let wrote = false
      let hosted = false
      const result = await transact(async (transaction, touch) => {
        wrote = false
        hosted = false
        const review = firestoreReviewStore(db, reviewEnv, transaction, touch)
        return run({
          /** Check for a publish lock in the review environment before queueing work. */
          canQueue: () => canQueueDuringPublish(db, transaction, reviewEnv),
          /**
           * Create a draft batch and its live revision signal atomically with the run that
           * uses it.
           */
          async createDraftBatch(batch) {
            wrote = true
            transaction.create(db.collection('reviewBatches').doc(batch.id), {
              ...batch,
              env: reviewEnv,
            })
            transaction.set(
              db.doc(signalPath(liveEnvKey(reviewEnv), batch.id)),
              { revision: batch.revision }
            )
          },
          /**
           * Load edits for the requested plates in one transactional read for the queue
           * projection.
           */
          async reviewFields(batchId, plateIds) {
            const edits = db
              .collection('reviewBatches')
              .doc(batchId)
              .collection('edits')
            const fields = new Map<string, EditableFields>()
            for (let offset = 0; offset < plateIds.length; offset += 100) {
              const snapshots = await transaction.getAll(
                ...plateIds
                  .slice(offset, offset + 100)
                  .map((id) => edits.doc(id))
              )
              for (const snapshot of snapshots)
                if (snapshot.exists)
                  fields.set(
                    snapshot.id,
                    snapshot.get('fields') as EditableFields
                  )
            }
            return fields
          },
          /**
           * Read a batch only when it belongs to the review environment bound to this
           * adapter.
           */
          async batch(id) {
            const doc = await transaction.get(
              db.collection('reviewBatches').doc(id)
            )
            if (doc.get('env') !== reviewEnv) return null
            const value = doc.data()!
            delete value.env
            delete value.publishReservation
            return {
              ...value,
              stateOrders: value.stateOrders ?? {},
            } as import('../review/types').ReviewBatch
          },
          /** List pipeline runs in this jobs environment for queue ordering and status. */
          async runs() {
            const snapshot = await transaction.get(runs.where('env', '==', env))
            return snapshot.docs.map((doc) => doc.data() as PipelineRun)
          },
          /** Resolve a run by a valid document ID and enforce its environment boundary. */
          async getRun(id) {
            if (!id || id.includes('/')) return null
            const doc = await transaction.get(runs.doc(id))
            return doc.get('env') === env ? (doc.data() as PipelineRun) : null
          },
          /** Stage the run document update in the current transaction. */
          setRun(run) {
            wrote = true
            transaction.set(runs.doc(run.id), run)
          },
          /** Resolve a job by ID within the current jobs environment. */
          async get(id) {
            const doc = await transaction.get(jobs.doc(id))
            return doc.get('env') === env ? (doc.data() as TaggingJob) : null
          },
          /** List this environment's jobs so claims and status use the same scope. */
          async getMany(ids) {
            const result: TaggingJob[] = []
            for (let offset = 0; offset < ids.length; offset += 100) {
              const snapshots = await transaction.getAll(
                ...ids.slice(offset, offset + 100).map((id) => jobs.doc(id))
              )
              for (const snapshot of snapshots)
                if (snapshot.get('env') === env)
                  result.push(snapshot.data() as TaggingJob)
            }
            return result
          },
          async list(plateId) {
            const scoped = jobs.where('env', '==', env)
            const snapshot = await transaction.get(
              plateId ? scoped.where('plateId', '==', plateId) : scoped
            )
            return snapshot.docs.map((doc) => doc.data() as TaggingJob)
          },
          async nextStandaloneDesktopJob(now, localScope) {
            const scoped = jobs.where('env', '==', env)
            const queued = await oldestDesktopJob(
              transaction,
              scoped.where('state', '==', 'queued').orderBy('createdAt'),
              localScope
            )
            const expired = await oldestDesktopJob(
              transaction,
              scoped
                .where('state', '==', 'claimed')
                .where('leaseExpiresAt', '<=', now)
                .orderBy('createdAt')
                .orderBy('leaseExpiresAt'),
              localScope
            )
            return expired && (!queued || compareJobAge(expired, queued) < 0)
              ? expired
              : queued
          },
          async listActiveJobs(localScope) {
            const query = jobs
              .where('env', '==', env)
              .where('localScope', '==', localScope)
              .where('state', 'in', ['queued', 'claimed'])
              .orderBy(FieldPath.documentId())
            const active: TaggingJob[] = []
            for await (const job of readClaimJobs(transaction, query))
              active.push(job)
            return active
          },
          /** Read the batch revision and its plate edit together for stale-input checks. */
          async review(batchId, plateId) {
            const ref = db.collection('reviewBatches').doc(batchId)
            const batch = await transaction.get(ref)
            if (!batch.exists || batch.get('env') !== reviewEnv) return null
            const snapshot = await transaction.get(
              ref.collection('edits').doc(plateId)
            )
            const edit = snapshot.data() as ProposedEdit | undefined
            return {
              baselineVersion: batch.get('baselineVersion') as number,
              fields: edit?.fields ?? {},
              edit,
            }
          },
          /**
           * Resolve the requester's active membership role when a stage is ready to write
           * a draft.
           */
          async pipelineRequesterRole(uid) {
            const member = await firestoreMemberByUid(db, uid, transaction)
            return member?.uid === uid && member.status === 'active'
              ? member.role
              : null
          },
          commitDraft(...args) {
            wrote = true
            return review.commit(...args)
          },
          /**
           * Stage a create-only job write so duplicate IDs cannot overwrite earlier work.
           */
          create(job) {
            wrote = true
            if (job.route === 'hosted') hosted = true
            transaction.create(jobs.doc(job.id), job)
          },
          /** Stage the updated job record in the current transaction. */
          set(job) {
            wrote = true
            if (job.route === 'hosted') hosted = true
            transaction.set(jobs.doc(job.id), job)
          },
          setEnhancedImage(id, bytes) {
            wrote = true
            transaction.create(enhancedImages.doc(id), { bytes, env })
          },
        })
      })
      if (wrote) signalChange(db, reviewEnv, 'pipeline')
      if (hosted) signalChange(db, reviewEnv, 'gateway')
      return result
    },
    /** Load the worker token record by hash within the adapter's environment. */
    async getToken(hash) {
      const doc = await tokens.doc(hash).get()
      return doc.get('env') === env ? (doc.data() as WorkerToken) : null
    },
    /** Create a token record by hash without replacing an issued token. */
    async createToken(token) {
      await tokens.doc(token.hash).create(token)
    },
    /** Record a revocation timestamp on a token from this environment. */
    async revokeToken(hash, at) {
      await db.runTransaction(async (transaction) => {
        const ref = tokens.doc(hash)
        const token = await transaction.get(ref)
        if (token.get('env') === env && token.get('revokedAt') === null)
          transaction.update(ref, { revokedAt: at })
      })
    },
  }
}
