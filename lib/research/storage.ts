import { createHash } from 'node:crypto'
import type { Firestore } from '@google-cloud/firestore'
import type { ResearchStateStore } from './state'
import { fileResearchState } from './stores/file-state'

let database: Firestore | undefined
/** Choose the research storage namespace for the current deployment or local session. */
export function researchEnvironment() {
  return process.env.VERCEL_ENV === 'preview'
    ? `preview:${process.env.VERCEL_GIT_COMMIT_REF ?? 'unknown'}`
    : (process.env.VERCEL_ENV ?? 'development')
}

/** Retain one research Firestore client to reuse its connections and credentials. */
export async function researchDatabase(): Promise<Firestore> {
  if (!database) {
    const { Firestore } = await import('@google-cloud/firestore')
    if (process.env.FIRESTORE_EMULATOR_HOST)
      database = new Firestore({
        projectId: process.env.GCP_PROJECT_ID ?? 'demo-plate-curator',
      })
    else {
      const { gcpAuthClient } = await import('../gcp/credentials')
      if (!process.env.GCP_PROJECT_ID)
        throw new Error(
          'GCP_PROJECT_ID is required for persistent research state'
        )
      database = new Firestore({
        projectId: process.env.GCP_PROJECT_ID,
        authClient: gcpAuthClient(),
      })
    }
  }
  return database
}

/**
 * Create a Firestore state adapter that isolates research values by deployment
 * environment.
 */
export function firestoreResearchState(
  db: Firestore,
  env: string
): ResearchStateStore {
  /** Derive an environment-specific document ID for one research state key. */
  const ref = (key: string) =>
    db.collection('researchState').doc(
      createHash('sha256')
        .update(env + '\n' + key)
        .digest('hex')
    )
  return {
    /** Read the stored state value or return null when the document is absent. */
    async read<T>(key: string) {
      const record = await ref(key).get()
      return record.exists && record.get('env') === env
        ? (record.get('value') as T)
        : null
    },
    /**
     * Apply the state change in a Firestore transaction to serialize updates across
     * processes.
     */
    update<T, R>(
      key: string,
      change: (value: T | null) => { value: T; result: R }
    ) {
      return db.runTransaction(async (transaction) => {
        const record = await transaction.get(ref(key))
        const changed = change(
          record.exists && record.get('env') === env
            ? (record.get('value') as T)
            : null
        )
        transaction.set(ref(key), { env, key, value: changed.value })
        return changed.result
      })
    },
  }
}

/**
 * Store research state and retrieval caches in local files for Eve dev and in
 * environment-scoped Firestore for hosted runs.
 */
export async function researchState(): Promise<ResearchStateStore> {
  if (process.env.EVE_DEV === '1' && !process.env.VERCEL)
    return fileResearchState('.eve/research')
  return firestoreResearchState(await researchDatabase(), researchEnvironment())
}
