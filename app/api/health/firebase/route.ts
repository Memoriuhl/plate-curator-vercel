import { readCatalogVersion } from '../../../../lib/gcp/firestore'
import { firebaseHealth } from '../../../../lib/health/firebase-health'

export async function GET() {
  return firebaseHealth(readCatalogVersion)
}