import type { ReviewStore } from '../review/types'
import type { Environment, JobsStore, TaggingJob, WorkerToken } from './types'
import {
  shouldWriteCapabilities,
  type WorkerCapabilityRecord,
} from './capabilities'
import type { PipelineRun } from './queue-types'
import {
  claimable,
  compareJobAge,
  isStandaloneDesktopJob,
} from './claim-eligibility'

/**
 * Create an in-memory jobs store so tests and fixture runs can exercise scoped
 * transactions without Firestore.
 */
export function createMemoryJobsStore(
  review: ReviewStore,
  environment: Environment
) {
  const jobs = new Map<string, TaggingJob>()
  const enhancedImages = new Map<string, Buffer>()
  const tokens = new Map<string, WorkerToken>()
  const capabilities = new Map<string, WorkerCapabilityRecord>()
  const runs = new Map<string, PipelineRun>()
  let pending: Promise<unknown> = Promise.resolve()
  /**
   * Bind the shared in-memory records to one environment with the same visibility rules
   * as Firestore.
   */
  function forEnvironment(
    env: Environment,
    scopedReview = env === environment ? review : undefined
  ): JobsStore {
    return {
      env,
      async readEnhancedImage(id) {
        const bytes = enhancedImages.get(`${env}:${id}`)
        return bytes ? Buffer.from(bytes) : null
      },
      /**
       * Return a copy of the scope's heartbeat so callers cannot mutate stored
       * capabilities.
       */
      async readCapabilities(scope) {
        return structuredClone(capabilities.get(`${env}:${scope}`) ?? null)
      },
      /**
       * Update the scope's heartbeat only when its data changed or the polling interval
       * elapsed.
       */
      async writeCapabilities(scope, record) {
        const key = `${env}:${scope}`
        if (shouldWriteCapabilities(capabilities.get(key) ?? null, record))
          capabilities.set(key, structuredClone(record))
      },
      /**
       * Serialize memory transactions and apply staged writes only after their callback
       * finishes.
       */
      transaction(run) {
        const next = pending.then(async () => {
          const writes = new Map<string, TaggingJob>()
          const imageWrites = new Map<string, Buffer>()
          const runWrites = new Map<string, PipelineRun>()
          const value = await run({
            /**
             * Create a batch in the scoped review store and surface duplicate IDs as
             * transaction failures.
             */
            async createDraftBatch(batch) {
              if ((await scopedReview?.create(batch)) !== 'ok')
                throw Error('Batch already exists')
            },
            /**
             * Read a batch from the associated review environment when one is
             * configured.
             */
            async batch(id) {
              return (await scopedReview?.getBatch(id)) ?? null
            },
            /** Return snapshots of pipeline runs visible in this environment. */
            async runs() {
              return structuredClone(
                [...runs.values()].filter((run) => run.env === env)
              )
            },
            /**
             * Read a run by ID and clone it so uncommitted mutations stay local to the
             * caller.
             */
            async getRun(id) {
              const run = runs.get(id)
              return run?.env === env ? structuredClone(run) : null
            },
            /** Stage a copy of the run for this in-memory transaction. */
            setRun(run) {
              runWrites.set(run.id, structuredClone(run))
            },
            /** Return a copy of a job visible in the current environment. */
            async get(id) {
              const job = jobs.get(id)
              return job?.env === env ? structuredClone(job) : null
            },
            /**
             * Return job snapshots for this environment so claim selection cannot mutate
             * stored records.
             */
            async list(plateId) {
              return structuredClone(
                [...jobs.values()].filter(
                  (job) =>
                    job.env === env && (!plateId || job.plateId === plateId)
                )
              )
            },
            async nextStandaloneDesktopJob(now, localScope) {
              const candidates = [...jobs.values()].filter(
                (job) =>
                  job.env === env &&
                  isStandaloneDesktopJob(job, localScope) &&
                  claimable(job, now)
              )
              return structuredClone(candidates.sort(compareJobAge)[0] ?? null)
            },
            async listActiveJobs(localScope) {
              return structuredClone(
                [...jobs.values()].filter(
                  (job) =>
                    job.env === env &&
                    job.localScope === localScope &&
                    (job.state === 'queued' || job.state === 'claimed')
                )
              )
            },
            /** Read a plate edit with the batch revision needed to validate job input. */
            async review(batchId, plateId) {
              const batch = await scopedReview?.getBatch(batchId)
              if (!batch) return null
              const edit =
                (await scopedReview!.getEdit(batchId, plateId)) ?? undefined
              return {
                baselineVersion: batch.baselineVersion,
                fields: edit?.fields ?? {},
                edit,
              }
            },
            /**
             * Delegate a draft commit to the scoped review store and surface missing
             * stores as a conflict.
             */
            async commitDraft(...args) {
              return (
                (await scopedReview?.commit(...args)) ?? 'revision_mismatch'
              )
            },
            /** Stage creation of a job and reject an ID already in the store. */
            create(job) {
              if (jobs.has(job.id)) throw new Error('Job already exists')
              writes.set(job.id, structuredClone(job))
            },
            /**
             * Stage an updated job snapshot for commit after the transaction callback
             * returns.
             */
            set(job) {
              writes.set(job.id, structuredClone(job))
            },
            setEnhancedImage(id, bytes) {
              imageWrites.set(id, Buffer.from(bytes))
            },
          })
          for (const [id, bytes] of imageWrites)
            enhancedImages.set(`${env}:${id}`, bytes)
          for (const [id, job] of writes) jobs.set(id, job)
          for (const [id, run] of runWrites) runs.set(id, run)
          return value
        })
        pending = next.catch(() => {})
        return next
      },
      /** Read a copy of a worker token only from the current environment. */
      async getToken(hash) {
        const token = tokens.get(hash)
        return token?.env === env ? structuredClone(token) : null
      },
      /** Store a new worker token and reject an existing hash. */
      async createToken(token) {
        if (tokens.has(token.hash)) throw new Error('Token already exists')
        tokens.set(token.hash, structuredClone(token))
      },
      /** Mark a token from this environment as revoked at the supplied time. */
      async revokeToken(hash, at) {
        const token = tokens.get(hash)
        if (token?.env === env && token.revokedAt === null)
          tokens.set(hash, { ...token, revokedAt: at })
      },
    }
  }
  return { ...forEnvironment(environment), forEnvironment }
}
