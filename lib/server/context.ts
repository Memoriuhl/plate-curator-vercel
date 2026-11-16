import 'server-only'
import { authenticate, parseOwnerUids } from '../auth/actor'
import { googleSecureTokenJwks } from '../auth/google-jwks'
import { verifyIdToken } from '../auth/verify-id-token'
import type { Plate, Snapshot } from '../catalog/types'
import { firestoreCatalogSource } from '../catalog/firestore-source'
import { fixtureSource } from '../catalog/fixture-source'
import { catalogSourceKind } from '../catalog/source-kind'
import { gcpAuthClient } from '../gcp/credentials'
import { firestoreJobsStore } from '../jobs/firestore-store'
import { verifyWorkerToken } from '../jobs/tokens'
import type { Environment, JobsDeps } from '../jobs/types'
import { firestorePublishLock, firestorePublishPointer, firestorePublishRecords } from '../publish/firestore'
import { gcsSnapshots } from '../publish/gcs-snapshots'
import type { PublishDeps } from '../publish/types'
import { requireEnv } from '../env'
import { stagingFirestore } from '../gcp/firestore'
import { loadSnapshot } from '../gcp/storage'
import { firestoreReviewStore } from '../review/firestore-store'
import type { ReviewDeps } from '../review/types'
import { json } from './respond'

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

export function catalog(snapshotLoader: (version: number) => Promise<Snapshot> = loadSnapshot) {
  const { CATALOG_SOURCE, VERCEL_ENV } = process.env
  if (catalogSourceKind({ CATALOG_SOURCE, VERCEL_ENV }) === 'fixture') return fixtureSource()
  return firestoreCatalogSource(stagingFirestore(), snapshotLoader)
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

export function jobsDeps(): JobsDeps {
  return {
    store: firestoreJobsStore(stagingFirestore(), reviewEnv() as Environment),
    baseline: reviewDeps().baseline,
    now: () => Date.now(),
    id: () => crypto.randomUUID(),
    leaseMs: 5 * 60_000,
  }
}

export function publishDeps(): PublishDeps {
  const db = stagingFirestore()
  const env = reviewEnv()
  return {
    ...reviewDeps(),
    pointer: firestorePublishPointer(db, env),
    records: firestorePublishRecords(db, env),
    lock: firestorePublishLock(db, env),
    snapshots: gcsSnapshots(requireEnv('FIREBASE_STORAGE_BUCKET'), async () => (await gcpAuthClient().getAccessToken()).token ?? ''),
  }
}

export function publishAllowed(): boolean {
  return process.env.VERCEL_ENV === 'production' || process.env.ALLOW_PUBLISH === 'true'
}

export async function currentWorker(request: Request): Promise<{ ok: true; workerId: string } | { ok: false; response: Response }> {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization') ?? '')
  const workerId = match ? await verifyWorkerToken(jobsDeps(), match[1]) : null
  return workerId ? { ok: true, workerId } : { ok: false, response: json({ error: 'unauthenticated' }, 401) }
}
