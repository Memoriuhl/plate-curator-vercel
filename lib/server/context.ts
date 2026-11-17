import { isActiveOwner, normalizeEmail } from '../members/member'
import type { Actor } from '../review/types'
import 'server-only'
import { resumeHook } from 'workflow/api'
import { workflowPublishRunLookup } from './publish-runs'
import { verifyPreparedObject } from '../publish/object'
import { authenticate, parseOwnerUids } from '../auth/actor'
import { googleSecureTokenJwks } from '../auth/google-jwks'
import { verifyIdToken } from '../auth/verify-id-token'
import type { Plate, Snapshot } from '../catalog/types'
import { orderedStatePlates } from '../catalog/order'
import { firestoreCatalogSource } from '../catalog/firestore-source'
import { fixtureSource } from '../catalog/fixture-source'
import { catalogSourceKind } from '../catalog/source-kind'
import { getVercelOidcToken } from '@vercel/oidc'
import { gcpAuthClient } from '../gcp/credentials'
import type { HostedDeps } from '../jobs/hosted'
import { chooseTaggingModel, enabledTaggingModels, taggingModel, type TaggingChoice, type TaggingModel } from '../tagging/models'
import { gatewayAdapter } from '../../worker/model'
import { firestoreJobsStore } from '../jobs/firestore-store'
import { verifyWorkerToken } from '../jobs/tokens'
import type { Environment, JobsDeps } from '../jobs/types'
import { localJobsEnvironment, localPipelineScope } from '../jobs/local-scope'
import { firestorePublishControl, firestorePublishCurator, firestorePublishLock, firestorePublishPointer, firestorePublishRecords } from '../publish/firestore'
import { gcsSnapshots } from '../publish/gcs-snapshots'
import type { PublishDeps, RequesterAuthority } from '../publish/types'
import { expoPushSender, firestoreCatalogPushStore, type CatalogPushDeps } from '../publish/catalog-push'
import { requireEnv } from '../env'
import { stagingFirestore } from '../gcp/firestore'
import { loadSnapshot } from '../gcp/storage'
import type { LiveAccessDeps } from '../live/access'
import { firestoreLiveAccessWriter } from '../live/firestore-access'
import { firestoreReviewStore } from '../review/firestore-store'
import type { ReviewDeps } from '../review/types'
import { json } from './respond'
import { cachedJurisdiction } from './snapshot-cache'
import { membersStore } from './members'
import { createMemoryMembersStore } from '../members/memory-store'

const platesByVersion = new Map<number, Map<string, Plate>>()
const fixtureMembers = createMemoryMembersStore()

export function reviewEnv(): string {
  const env = process.env.VERCEL_ENV ?? 'development'
  return env === 'preview' ? `preview:${process.env.VERCEL_GIT_COMMIT_REF ?? 'unknown'}` : env
}

export function currentActor(request: Request) {
  const projectId = requireEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID')
  const store = () => catalogSourceKind({ CATALOG_SOURCE: process.env.CATALOG_SOURCE, VERCEL_ENV: process.env.VERCEL_ENV }) === 'fixture' ? fixtureMembers : membersStore()
  return authenticate(request, {
    verify: (token) => verifyIdToken(token, { projectId, jwks: googleSecureTokenJwks() }),
    ownerUids: parseOwnerUids(process.env.OWNER_UIDS),
    members: {
      getByEmail: email => store().getByEmail(email),
      getByUid: uid => store().getByUid(uid),
      activate: (email, uid, hash) => store().activate(email, uid, hash),
    },
  })
}

export function requesterAuthority(actor: Actor & { email: string; authorityEpoch: number }): RequesterAuthority {
  return { uid: actor.uid, email: normalizeEmail(actor.email), authorityEpoch: actor.authorityEpoch }
}

export async function currentActiveOwner(request: Request): Promise<{ ok: true; actor: Actor & { email: string; authorityEpoch: number } } | { ok: false; response: Response }> {
  const auth = await currentActor(request)
  if (!auth.ok) return auth
  if (auth.actor.role !== 'owner') return { ok: false, response: json({ error: 'forbidden' }, 403) }
  const member = await membersStore().getByUid(auth.actor.uid)
  if (!member || member.uid !== auth.actor.uid || !isActiveOwner(member)) return { ok: false, response: json({ error: 'forbidden' }, 403) }
  return { ok: true, actor: { ...auth.actor, email: normalizeEmail(member.email), authorityEpoch: member.authorityEpoch ?? 0 } }
}

export function catalog(snapshotLoader: (version: number) => Promise<Snapshot> = loadSnapshot) {
  const { CATALOG_SOURCE, VERCEL_ENV, PLATE_IMAGE_BASE } = process.env
  const imageBase = PLATE_IMAGE_BASE || null
  if (catalogSourceKind({ CATALOG_SOURCE, VERCEL_ENV }) === 'fixture') return fixtureSource(imageBase)
  return firestoreCatalogSource(stagingFirestore(), snapshotLoader, imageBase)
}

export function liveAccessDeps(): LiveAccessDeps {
  return { env: reviewEnv(), now: () => new Date(), write: firestoreLiveAccessWriter(stagingFirestore()) }
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
    async baselineAtVersion(version, plateId) {
      const kind = catalogSourceKind({ CATALOG_SOURCE: process.env.CATALOG_SOURCE, VERCEL_ENV: process.env.VERCEL_ENV })
      const snapshot = await cachedJurisdiction(version, plateId.split('.')[0], kind)
      if (snapshot.version !== version) throw new Error('Baseline catalog version unavailable')
      return snapshot.plates.find(plate => plate.id === plateId) ?? null
    },
    async stateBaseline(version, state, order) {
      const source = catalog()
      const kind = catalogSourceKind({ CATALOG_SOURCE: process.env.CATALOG_SOURCE, VERCEL_ENV: process.env.VERCEL_ENV })
      const snapshot = await cachedJurisdiction(version, state, kind)
      if (snapshot.version !== version) throw new Error('Baseline catalog version unavailable')
      if (!snapshot.plates.some(plate => plate.state === state)) return []
      return orderedStatePlates(snapshot, state, order === 'snapshot' ? { stateOrder: {}, stateProgress: {} } : await source.readCuratorState())
    },
    async supersedeRun(batch) {
      const revision = batch.approvalRun?.revision ?? (batch.state === 'submitted' ? batch.revision : batch.approval?.revision)
      if (revision === undefined) return
      await Promise.all([
        resumeHook(`approval:${batch.id}:${revision}`, { superseded: true }).catch(() => undefined),
        resumeHook(`publish:${batch.id}:${revision + 1}`, { superseded: true }).catch(() => undefined),
      ])
    },
    now: () => new Date().toISOString(),
  }
}

export function jobsDeps(): JobsDeps {
  const localScope = localPipelineScope()
  return {
    ...(localScope ? { localScope } : {}),
    store: firestoreJobsStore(stagingFirestore(), localScope ? localJobsEnvironment(localScope) : reviewEnv() as Environment, reviewEnv()),
    baseline: reviewDeps().baseline,
    baselineAtVersion: reviewDeps().baselineAtVersion,
    stateBaseline: reviewDeps().stateBaseline,
    now: () => Date.now(),
    id: () => crypto.randomUUID(),
    leaseMs: 5 * 60_000,
  }
}

export function taggingModels(runsOn?: TaggingModel['runsOn']): TaggingModel[] {
  const enabled = enabledTaggingModels(process.env.TAGGING_MODELS)
  return runsOn ? enabled.filter(model => model.runsOn === runsOn) : enabled
}

export function chooseModel(requested: unknown, runsOn?: TaggingModel['runsOn']): TaggingChoice {
  return chooseTaggingModel(requested, taggingModels(runsOn), process.env.TAGGING_DEFAULT_MODEL)
}

export async function hostedTaggingDeps(modelId: string): Promise<HostedDeps> {
  const choice = taggingModel(modelId)
  if (choice?.runsOn !== 'gateway') throw new Error('Hosted tagging needs a gateway model')
  const source = catalog()
  return {
    jobs: jobsDeps(),
    adapter: gatewayAdapter({ apiKey: process.env.AI_GATEWAY_API_KEY || await getVercelOidcToken(), model: choice.model }),
    async plate(job) {
      const plate = job.inputPlate
      if (!plate) return null
      const imageUrl = source.imageUrl(process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' ? { ...plate, imageUrl: undefined } : plate)
      return { id: plate.id, state: plate.state, displayName: plate.displayName, image: plate.image, tags: plate.tags ?? [], ...(imageUrl ? { imageUrl } : {}) }
    },
    async image(plate) {
      if (!plate.imageUrl) return null
      const response = await fetch(plate.imageUrl, { signal: AbortSignal.timeout(30_000) })
      if (response.status === 404) return null
      if (!response.ok) throw Object.assign(new Error(`Image request failed: ${response.status}`), { status: response.status })
      return Buffer.from(await response.arrayBuffer()).toString('base64')
    },
  }
}

export function publishControl() { return firestorePublishControl(stagingFirestore()) }

export function publishDeps(): PublishDeps {
  const db = stagingFirestore()
  const env = reviewEnv()
  const snapshots = gcsSnapshots(requireEnv('FIREBASE_STORAGE_BUCKET'), async () => (await gcpAuthClient().getAccessToken()).token ?? '')
  return {
    ...reviewDeps(),
    control: publishControl(),
    curator: firestorePublishCurator(db, env),
    pointer: firestorePublishPointer(db, env, record => verifyPreparedObject(snapshots, record)),
    records: firestorePublishRecords(db, env, workflowPublishRunLookup()),
    lock: firestorePublishLock(db, env),
    snapshots,
  }
}

export function publishAllowed(): boolean {
  return process.env.VERCEL_ENV === 'production' || process.env.ALLOW_PUBLISH === 'true'
}

export function catalogPushDeps(): CatalogPushDeps {
  const enabled = process.env.CATALOG_PUSH_ENABLED === 'true'
  if (enabled && process.env.GCP_PROJECT_ID !== 'license-plate-game-staging') throw new Error('Catalog push requires staging')
  return {
    enabled,
    get store() { return firestoreCatalogPushStore(stagingFirestore()) },
    send: enabled ? expoPushSender(requireEnv('EXPO_ACCESS_TOKEN')) : async () => [],
  }
}

export async function currentWorker(request: Request): Promise<{ ok: true; workerId: string } | { ok: false; response: Response }> {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization') ?? '')
  const workerId = match ? await verifyWorkerToken(jobsDeps(), match[1]) : null
  return workerId ? { ok: true, workerId } : { ok: false, response: json({ error: 'unauthenticated' }, 401) }
}
