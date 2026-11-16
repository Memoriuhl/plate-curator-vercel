import 'server-only'
import { authenticate, parseOwnerUids } from '../auth/actor'
import { googleSecureTokenJwks } from '../auth/google-jwks'
import { verifyIdToken } from '../auth/verify-id-token'
import type { Plate } from '../catalog/types'
import { firestoreCatalogSource } from '../catalog/firestore-source'
import { requireEnv } from '../env'
import { stagingFirestore } from '../gcp/firestore'
import { loadSnapshot } from '../gcp/storage'
import { firestoreReviewStore } from '../review/firestore-store'
import type { ReviewDeps } from '../review/types'

const platesByVersion = new Map<number, Map<string, Plate>>()

export function reviewEnv(): string {
  const env = process.env.VERCEL_ENV ?? 'development'
  return env === 'preview' ? `preview:${process.env.VERCEL_GIT_COMMIT_REF ?? 'unknown'}` : env
}

export function currentActor(request: Request) {
  const projectId = requireEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID')
  return authenticate(request, {
    verify: (token) => verifyIdToken(token, { projectId, jwks: googleSecureTokenJwks() }),
    ownerUids: parseOwnerUids(process.env.OWNER_UIDS),
  })
}

export function catalog() {
  return firestoreCatalogSource(stagingFirestore(), loadSnapshot)
}

export function reviewDeps(): ReviewDeps {
  return {
    store: firestoreReviewStore(stagingFirestore(), reviewEnv()),
    async baseline(plateId) {
      const snapshot = await catalog().readSnapshot()
      let plates = platesByVersion.get(snapshot.version)
      if (!plates) {
        plates = new Map(snapshot.plates.map((plate) => [plate.id, plate]))
        platesByVersion.set(snapshot.version, plates)
      }
      return plates.get(plateId) ?? null
    },
    now: () => new Date().toISOString(),
  }
}
