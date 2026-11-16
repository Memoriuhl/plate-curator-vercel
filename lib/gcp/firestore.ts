import 'server-only'
import { Firestore } from '@google-cloud/firestore'
import { requireEnv } from '../env'
import { gcpAuthClient } from './credentials'

let firestore: Firestore | undefined

export function stagingFirestore(): Firestore {
  firestore ??= new Firestore({
    projectId: requireEnv('GCP_PROJECT_ID'),
    authClient: gcpAuthClient(),
  })
  return firestore
}

export async function readCatalogVersion(): Promise<number> {
  const snapshot = await stagingFirestore().doc('config/catalog').get()
  const version = snapshot.get('version')
  if (typeof version !== 'number') throw new Error('config/catalog has no numeric version')
  return version
}