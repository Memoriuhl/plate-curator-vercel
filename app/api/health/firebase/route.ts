import { connection } from 'next/server'
import { readCatalogVersion } from '../../../../lib/gcp/firestore'
import { firebaseHealth } from '../../../../lib/health/firebase-health'

export async function GET() {
  await connection()
  return firebaseHealth(readCatalogVersion)
}
