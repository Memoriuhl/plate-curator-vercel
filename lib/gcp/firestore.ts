import 'server-only'
import { Firestore } from '@google-cloud/firestore'
import { requireEnv } from '../env'
import { gcpAuthClient } from './credentials'
import { instrumentFirestore } from '../dev/usage-counter'

let firestore: Firestore | undefined

/**
 * Keep one Firestore client per process to reuse its connection and auth setup. A local
 * emulator needs no cloud credentials.
 */
export function stagingFirestore(): Firestore {
  firestore ??= instrumentFirestore(
    new Firestore(
      process.env.FIRESTORE_EMULATOR_HOST
        ? { projectId: requireEnv('GCP_PROJECT_ID') }
        : {
            projectId: requireEnv('GCP_PROJECT_ID'),
            authClient: gcpAuthClient(),
          }
    )
  )
  return firestore
}

/** Read and validate the catalog version used by the Firebase health endpoint. */
export async function readCatalogVersion(): Promise<number> {
  const snapshot = await stagingFirestore().doc('config/catalog').get()
  const version = snapshot.get('version')
  if (typeof version !== 'number')
    throw new Error('config/catalog has no numeric version')
  return version
}
