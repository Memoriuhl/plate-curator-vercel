import 'server-only'
import { Firestore } from '@google-cloud/firestore'
import { requireEnv } from '../env'
import { gcpAuthClient } from './credentials'

let firestore: Firestore | undefined

/** Reuse the authenticated Firestore client for the configured staging database. */
export function stagingFirestore(): Firestore {
  firestore ??= new Firestore({
    projectId: requireEnv('GCP_PROJECT_ID'),
    authClient: gcpAuthClient(),
  })
  return firestore
}

/** Read and validate the catalog version used by the Firebase health endpoint. */
export async function readCatalogVersion(): Promise<number> {
  const snapshot = await stagingFirestore().doc('config/catalog').get()
  const version = snapshot.get('version')
  if (typeof version !== 'number') throw new Error('config/catalog has no numeric version')
  return version
}