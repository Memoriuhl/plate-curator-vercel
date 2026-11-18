import { connection } from 'next/server'
import { readCatalogVersion } from '../../../../lib/gcp/firestore'
import { firebaseHealth } from '../../../../lib/health/firebase-health'

/** Check Firebase and return the catalog pointer health at request time. */
export async function GET() {
  await connection()
  return firebaseHealth(readCatalogVersion)
}
