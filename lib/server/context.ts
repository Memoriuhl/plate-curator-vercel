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
import { readCommonsImage } from '../../worker/remote-image'
import { commonsImageUrl } from '../jobs/image-options'

const platesByVersion = new Map<number, Map<string, Plate>>()
const fixtureMembers = createMemoryMembersStore()

/**
 * Derive a branch-specific preview review environment and a stable namespace for other
 * deployments.
 */
export function reviewEnv(): string {
  const env = process.env.VERCEL_ENV ?? 'development'
  return env === 'preview' ? `preview:${process.env.VERCEL_GIT_COMMIT_REF ?? 'unknown'}` : env
}

/** Build the dependencies that authenticate the current route request. */
export function currentActor(request: Request) {
  const projectId = requireEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID')
  /** Select the fixture or live membership store used by the request's catalog mode. */
  const store = () => catalogSourceKind({ CATALOG_SOURCE: process.env.CATALOG_SOURCE, VERCEL_ENV: process.env.VERCEL_ENV }) === 'fixture' ? fixtureMembers : membersStore()
  return authenticate(request, {
    /** Verify an ID token against the configured Firebase project. */
    verify: (token) => verifyIdToken(token, { projectId, jwks: googleSecureTokenJwks() }),
    ownerUids: parseOwnerUids(process.env.OWNER_UIDS),
    members: {
      /** Resolve the current member for a normalized sign-in email. */
      getByEmail: email => store().getByEmail(email),
      /** Resolve membership by the verified account's UID. */
      getByUid: uid => store().getByUid(uid),
      /** Activate an invitation in the currently selected membership store. */
      activate: (email, uid, hash) => store().activate(email, uid, hash),
    },
  })
}

/** Capture the owner's identity and authority epoch for a durable publish request. */
export function requesterAuthority(actor: Actor & { email: string; authorityEpoch: number }): RequesterAuthority {
  return { uid: actor.uid, email: normalizeEmail(actor.email), authorityEpoch: actor.authorityEpoch }
}

/**
 * Recheck live membership before granting the active owner authority needed for this
 * operation.
 */
export async function currentActiveOwner(request: Request): Promise<{ ok: true; actor: Actor & { email: string; authorityEpoch: number } } | { ok: false; response: Response }> {
  const auth = await currentActor(request)
  if (!auth.ok) return auth
  if (auth.actor.role !== 'owner') return { ok: false, response: json({ error: 'forbidden' }, 403) }
  const member = await membersStore().getByUid(auth.actor.uid)
  if (!member || member.uid !== auth.actor.uid || !isActiveOwner(member)) return { ok: false, response: json({ error: 'forbidden' }, 403) }
  return { ok: true, actor: { ...auth.actor, email: normalizeEmail(member.email), authorityEpoch: member.authorityEpoch ?? 0 } }
}

/** Select the catalog source and image base for the current deployment settings. */
export function catalog(snapshotLoader: (version: number) => Promise<Snapshot> = loadSnapshot) {
  const { CATALOG_SOURCE, VERCEL_ENV, PLATE_IMAGE_BASE } = process.env
  const imageBase = PLATE_IMAGE_BASE || null
  if (catalogSourceKind({ CATALOG_SOURCE, VERCEL_ENV }) === 'fixture') return fixtureSource(imageBase)
  return firestoreCatalogSource(stagingFirestore(), snapshotLoader, imageBase)
}

/** Build the live grant writer and clock scoped to this review environment. */
export function liveAccessDeps(): LiveAccessDeps {
  return { env: reviewEnv(), now: () => new Date(), write: firestoreLiveAccessWriter(stagingFirestore()) }
}

/** Wire together the review store, baseline readers and clock for route operations. */
export function reviewDeps(): ReviewDeps {
  const jurisdictionIndexes = new Map<string, Promise<Map<string, Plate>>>()
  return {
    store: firestoreReviewStore(stagingFirestore(), reviewEnv()),
    /**
     * Load the current catalog plate through an index shared by reads of the same
     * version.
     */
    async baseline(plateId) {
      const snapshot = await catalog().readSnapshot()
      let plates = platesByVersion.get(snapshot.version)
      if (!plates) {
        plates = new Map(snapshot.plates.map((plate) => [plate.id, plate]))
        platesByVersion.set(snapshot.version, plates)
      }
      return plates.get(plateId) ?? null
    },
    /**
     * Find a baseline plate in its requested snapshot version using a jurisdiction
     * index.
     */
    async baselineAtVersion(version, plateId) {
      const kind = catalogSourceKind({ CATALOG_SOURCE: process.env.CATALOG_SOURCE, VERCEL_ENV: process.env.VERCEL_ENV })
      const state = plateId.split('.')[0]
      const key = `${version}:${state}`
      let index = jurisdictionIndexes.get(key)
      if (!index) {
        index = cachedJurisdiction(version, state, kind).then(snapshot => {
          if (snapshot.version !== version) throw new Error('Baseline catalog version unavailable')
          return new Map(snapshot.plates.map(plate => [plate.id, plate]))
        })
        jurisdictionIndexes.set(key, index)
      }
      return (await index).get(plateId) ?? null
    },
    /**
     * Load a state's baseline plates in curator order for the specified catalog version.
     */
    async stateBaseline(version, state, order) {
      const source = catalog()
      const kind = catalogSourceKind({ CATALOG_SOURCE: process.env.CATALOG_SOURCE, VERCEL_ENV: process.env.VERCEL_ENV })
      const snapshot = await cachedJurisdiction(version, state, kind)
      if (snapshot.version !== version) throw new Error('Baseline catalog version unavailable')
      if (!snapshot.plates.some(plate => plate.state === state)) return []
      return orderedStatePlates(snapshot, state, order === 'snapshot' ? { stateOrder: {}, stateProgress: {} } : await source.readCuratorState())
    },
    /**
     * Wake an approval workflow when a newer batch revision displaces its saved input.
     */
    async supersedeRun(batch) {
      const revision = batch.approvalRun?.revision ?? (batch.state === 'submitted' ? batch.revision : batch.approval?.revision)
      if (revision === undefined) return
      await Promise.all([
        resumeHook(`approval:${batch.id}:${revision}`, { superseded: true }).catch(() => undefined),
        resumeHook(`publish:${batch.id}:${revision + 1}`, { superseded: true }).catch(() => undefined),
      ])
    },
    /** Return the ISO timestamp used to record review changes. */
    now: () => new Date().toISOString(),
  }
}

/**
 * Build job dependencies with the appropriate queue scope, review baseline readers and
 * lease duration.
 */
export function jobsDeps({ unscoped = false } = {}): JobsDeps {
  const localScope = unscoped ? undefined : localPipelineScope()
  return {
    ...(localScope ? { localScope } : {}),
    store: firestoreJobsStore(stagingFirestore(), localScope ? localJobsEnvironment(localScope) : reviewEnv() as Environment, reviewEnv()),
    baseline: reviewDeps().baseline,
    baselineAtVersion: reviewDeps().baselineAtVersion,
    stateBaseline: reviewDeps().stateBaseline,
    configuredOwnerUids: parseOwnerUids(process.env.OWNER_UIDS),
    /** Provide the millisecond clock used by job leases and stage timings. */
    now: () => Date.now(),
    /** Generate a unique job or claim identifier for server operations. */
    id: () => crypto.randomUUID(),
    leaseMs: 5 * 60_000,
  }
}

/** List enabled tagging models, optionally limiting the list to one executor. */
export function taggingModels(runsOn?: TaggingModel['runsOn']): TaggingModel[] {
  const enabled = enabledTaggingModels(process.env.TAGGING_MODELS)
  return runsOn ? enabled.filter(model => model.runsOn === runsOn) : enabled
}

/** Select the requested or configured default tagging model from the enabled set. */
export function chooseModel(requested: unknown, runsOn?: TaggingModel['runsOn']): TaggingChoice {
  return chooseTaggingModel(requested, taggingModels(runsOn), process.env.TAGGING_DEFAULT_MODEL)
}

/** Build the Gateway tagging executor and its catalog plate and image readers. */
export async function hostedTaggingDeps(modelId: string): Promise<HostedDeps> {
  const choice = taggingModel(modelId)
  if (choice?.runsOn !== 'gateway') throw new Error('Hosted tagging needs a gateway model')
  const source = catalog()
  return {
    jobs: jobsDeps(),
    adapter: gatewayAdapter({ apiKey: process.env.AI_GATEWAY_API_KEY || await getVercelOidcToken(), model: choice.model }),
    /** Resolve the job's pinned input plate and its image URL for hosted inference. */
    async plate(job) {
      const plate = job.inputPlate
      if (!plate) return null
      const projectedImage = job.queueRunId && commonsImageUrl(plate.imageUrl)
      const imageUrl = projectedImage || source.imageUrl(process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' ? { ...plate, imageUrl: undefined } : plate)
      return { ...plate, tags: plate.tags ?? [], ...(imageUrl ? { imageUrl } : {}) }
    },
    /**
     * Read the supported plate image and encode its bytes for the hosted tagging
     * adapter.
     */
    async image(plate) {
      if (!plate.imageUrl) return null
      if (commonsImageUrl(plate.imageUrl)) return (await readCommonsImage(plate.imageUrl)).toString('base64')
      const response = await fetch(plate.imageUrl, { signal: AbortSignal.timeout(30_000) })
      if (response.status === 404) return null
      if (!response.ok) throw Object.assign(new Error(`Image request failed: ${response.status}`), { status: response.status })
      return Buffer.from(await response.arrayBuffer()).toString('base64')
    },
  }
}

/** Resolve the Firestore adapter for publish controls in the staging database. */
export function publishControl() { return firestorePublishControl(stagingFirestore()) }

/**
 * Assemble the release dependencies for the current environment, including locks,
 * snapshots and receipts.
 */
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

/**
 * Check that publishing is available in the current deployment under the configured
 * release policy.
 */
export function publishAllowed(): boolean {
  return process.env.VERCEL_ENV === 'production' || process.env.ALLOW_PUBLISH === 'true'
}

/** Configure the catalog push sender and lazy store for enabled release notifications. */
export function catalogPushDeps(): CatalogPushDeps {
  const enabled = process.env.CATALOG_PUSH_ENABLED === 'true'
  if (enabled && process.env.GCP_PROJECT_ID !== 'license-plate-game-staging') throw new Error('Catalog push requires staging')
  return {
    enabled,
    /** Create the push notification store when the workflow needs it. */
    get store() { return firestoreCatalogPushStore(stagingFirestore()) },
    send: enabled ? expoPushSender(requireEnv('EXPO_ACCESS_TOKEN')) : async () => [],
  }
}

/**
 * Authenticate the current worker against a bearer token issued in the jobs environment.
 */
export async function currentWorker(request: Request): Promise<{ ok: true; workerId: string } | { ok: false; response: Response }> {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization') ?? '')
  const workerId = match ? await verifyWorkerToken(jobsDeps(), match[1]) : null
  return workerId ? { ok: true, workerId } : { ok: false, response: json({ error: 'unauthenticated' }, 401) }
}
