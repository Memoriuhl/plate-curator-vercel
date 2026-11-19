import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { HookNotFoundError } from 'workflow/errors'
import { POST, GET } from '../app/api/batches/[id]/publish/route'
import { POST as abandon } from '../app/api/batches/[id]/abandon/route'
import {
  firestorePublishControl,
  firestorePublishCurator,
  firestorePublishLock,
  firestorePublishPointer,
  firestorePublishRecords,
} from '../lib/publish/firestore'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import { discardPlateChanges } from '../lib/review/discard-changes'
import {
  ensureDraft,
  freezeRelease,
  keepDraftValues,
  newSharedDraft,
} from '../lib/review/draft'
import { proposeEdit } from '../lib/review/batch'
import { plateRevision } from '../lib/review/revision'
import { firestoreVersionOrigin } from '../lib/review/firestore-version-origin'
import { sharedDraftId } from '../lib/review/draft-id'
import type { ProposedEdit, ReviewBatch } from '../lib/review/types'
import type { Plate } from '../lib/catalog/types'
import { publishBatch } from '../lib/publish/publish'
import { releaseActivityFor } from '../lib/publish/release-activity'
import { verifyPreparedObject } from '../lib/publish/object'
import {
  batch,
  command,
  fixture,
  owner,
  snapshot,
} from '../tests/publish/fixture'
import { db } from './setup'

const mocks = vi.hoisted(() => ({
  deps: vi.fn(),
  actor: vi.fn(),
  start: vi.fn(),
  getHookByToken: vi.fn(),
  resumeHook: vi.fn(),
  status: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('workflow/api', () => ({
  start: mocks.start,
  getHookByToken: mocks.getHookByToken,
  resumeHook: mocks.resumeHook,
}))
vi.mock('../workflows/approval', () => ({
  /** Stub workflow execution so retry route tests can focus on dispatch and command binding. */ publishRun:
    async () => {},
}))
vi.mock('../lib/server/context', () => ({
  currentActiveOwner: mocks.actor,
  /** Set deployment-level publish availability for this route test. */ publishAllowed:
    () => true,
  publishDeps: mocks.deps,
  reviewDeps: mocks.deps,
  /** Name the review environment whose shared draft this route test publishes. */
  reviewEnv: () => 'retry-route',
  /** Capture the fixture owner's identity and authority epoch for publish commands. */
  requesterAuthority: (actor: {
    uid: string
    email: string
    authorityEpoch: number
  }) => ({
    uid: actor.uid,
    email: actor.email,
    authorityEpoch: actor.authorityEpoch,
  }),
}))

const env = 'retry-route'
const initialTime = '2026-11-15T12:00:00Z'
let time = initialTime
const ctx = { params: Promise.resolve({ id: batch.id }) }
/** Build the POST request the route fixture passes to its handler. */
const request = (commandId: string) =>
  new Request('http://localhost/api/batches/batch/publish', {
    method: 'POST',
    body: JSON.stringify({ revision: 2, commandId }),
  })
const draftId = sharedDraftId(env)
const draftCtx = { params: Promise.resolve({ id: 'draft' }) }
/** Build the Owner's Publish request for one shared draft revision. */
const draftRequest = (revision: number, commandId: string) =>
  new Request('http://localhost/api/batches/draft/publish', {
    method: 'POST',
    body: JSON.stringify({ revision, commandId }),
  })
/** A release frozen from the shared draft at the fixture Batch's revision. */
const release = (): ReviewBatch => ({
  ...batch,
  kind: 'release',
  state: 'open',
  approval: null,
  source: { batchId: draftId, revision: batch.revision },
})
/** The shared draft `release()` was frozen from, still at that revision on v1. */
const seedReleaseDraft = async () =>
  expect(
    await mocks.deps().store.create({
      ...newSharedDraft(env, 1, owner, time),
      revision: batch.revision,
    })
  ).toBe('ok')
/** An editor's tag change, as the shared draft stores it. */
const tagEdit = (plateId: string, tags: string[]): ProposedEdit => ({
  plateId,
  fields: { tags },
  baseRevision: 'before',
  resultRevision: 'after',
  updatedAt: time,
  authorId: 'editor',
})

beforeEach(async () => {
  vi.resetAllMocks()
  time = initialTime
  await db.recursiveDelete(db.collection('publishCommands'))
  await db.recursiveDelete(db.collection('publishCommandStops'))
  await db.recursiveDelete(db.collection('publishRecords'))
  await db.recursiveDelete(db.collection('publishVersionBurns'))
  await db.recursiveDelete(db.collection('releaseFences'))
  await db.doc('locks/publish').delete()
  await db.recursiveDelete(db.doc('reviewBatches/batch'))
  await db.recursiveDelete(db.doc(`reviewBatches/${draftId}`))
  await deleteReleases()
  await db.doc('reviewBatches/batch').set({
    ...batch,
    env,
    approvalRun: { runId: 'old-stopped-run', revision: 1 },
  })
  await db.doc('curatorLive/retry-route/batchRevisions/batch').delete()
  await db.doc('config/catalog').set({ version: 1 })
  await db.doc('config/publishControl').set({
    paused: false,
    generation: 1,
    changedBy: { uid: 'owner', email: 'owner@example.com' },
    changedAt: time,
  })
  await db
    .doc('members/owner%40example.com')
    .set({ uid: 'owner', role: 'owner', status: 'active', authorityEpoch: 0 })
  mocks.actor.mockResolvedValue({
    ok: true,
    actor: { ...owner, email: 'owner@example.com', authorityEpoch: 0 },
  })
  mocks.status.mockResolvedValue('completed')
  mocks.getHookByToken.mockRejectedValue(new HookNotFoundError('missing'))
  mocks.start.mockResolvedValue({ runId: 'fresh-run' })
  const f = fixture()
  const pointer = firestorePublishPointer(db, env, (record) =>
    verifyPreparedObject(f.deps.snapshots, record)
  )
  const control = firestorePublishControl(db)
  const records = firestorePublishRecords(db, env, {
    runStatus: mocks.status,
    /** Control discovery by command token when the fixture has no recorded workflow ID. */ findRun:
      async (commandId) => {
        try {
          const run = await mocks.getHookByToken(`publish-command:${commandId}`)
          return { runId: run.runId, status: await mocks.status(run.runId) }
        } catch (error) {
          if (HookNotFoundError.is(error)) return null
          throw error
        }
      },
  })
  mocks.deps.mockReturnValue({
    ...f.deps,
    /** Read the controlled test clock so state and lease timestamps advance deterministically. */ now: () =>
      time,
    control,
    store: firestoreReviewStore(db, env),
    records,
    releaseActivity: releaseActivityFor(records, control, () => time),
    lock: firestorePublishLock(db, env),
    pointer,
    /** Read the live catalog version the shared draft is based on. */
    liveVersion: async () => (await pointer.read()).version,
    curator: firestorePublishCurator(db, env),
  })
})

/** Remove releases frozen from this environment's shared draft. */
async function deleteReleases() {
  const releases = await db
    .collection('reviewBatches')
    .where('env', '==', env)
    .where('kind', '==', 'release')
    .get()
  for (const doc of releases.docs) await db.recursiveDelete(doc.ref)
}

afterAll(async () => {
  await db.recursiveDelete(db.doc(`reviewBatches/${draftId}`))
  await deleteReleases()
  await db.recursiveDelete(db.collection('publishCommands'))
  await db.recursiveDelete(db.collection('publishCommandStops'))
  await db.recursiveDelete(db.collection('publishRecords'))
  await db.recursiveDelete(db.collection('publishVersionBurns'))
  await db.recursiveDelete(db.collection('releaseFences'))
  await db.recursiveDelete(db.doc('reviewBatches/batch'))
  await db.doc('curatorLive/retry-route/batchRevisions/batch').delete()
  await db.doc('config/catalog').delete()
  await db.doc('config/publishControl').delete()
  await db.doc('members/owner%40example.com').delete()
  await db.doc('locks/publish').delete()
  await db.terminate()
})

test('start failure after acceptance becomes eligible after the unbound TTL and a fresh click succeeds', async () => {
  mocks.start.mockRejectedValueOnce(new Error('start unavailable'))
  expect((await POST(request('failed-start'), ctx)).status).toBe(503)
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({
    canRetry: false,
    retryReason: 'locked',
  })
  time = '2026-11-15T12:02:01Z'
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({
    canRetry: true,
    retryReason: null,
  })
  expect((await POST(request('new-click'), ctx)).status).toBe(202)
  expect(
    (await db.doc('publishCommandStops/failed-start').get()).get('reason')
  ).toBe('superseded')
  expect(await mocks.deps().store.getBatch(batch.id)).toMatchObject({
    approvalRun: { runId: 'fresh-run' },
    publishCommand: { commandId: 'new-click' },
  })
})

test('a fresh run ending without a stop can be replaced and the old command remains fenced', async () => {
  expect((await POST(request('ended-run'), ctx)).status).toBe(202)
  const deps = mocks.deps()
  const accepted = (await deps.records.command('ended-run'))!.command
  deps.snapshots.read = async () => ({ version: 99, plates: [] })
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({
    error: 'invalid_snapshot',
  })
  expect((await db.doc('publishCommandStops/ended-run').get()).exists).toBe(
    false
  )
  mocks.status.mockResolvedValue('failed')
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({
    canRetry: true,
  })
  expect((await POST(request('replacement'), ctx)).status).toBe(202)
  expect(
    (await db.doc('publishCommandStops/ended-run').get()).get('reason')
  ).toBe('superseded')
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({
    error: 'superseded',
  })
})

test.each(['pause', 'approval', 'baseline'])(
  'unbound replay rechecks %s before starting any run',
  async (changed) => {
    const deps = mocks.deps()
    expect(
      await deps.records.accept({ ...command, commandId: 'replay' }, time)
    ).toMatchObject({ ok: true })
    if (changed === 'pause')
      await db
        .doc('config/publishControl')
        .update({ paused: true, generation: 2 })
    if (changed === 'approval')
      await db.doc('reviewBatches/batch').update({ approval: null })
    if (changed === 'baseline')
      await db.doc('config/catalog').update({ version: 2 })
    expect((await POST(request('replay'), ctx)).status).toBe(409)
    expect(mocks.start).not.toHaveBeenCalled()
  }
)

test('lost start response finds the token owner and binds the Batch without a duplicate start', async () => {
  const deps = mocks.deps()
  await deps.records.accept({ ...command, commandId: 'lost-response' }, time)
  mocks.getHookByToken.mockResolvedValue({ runId: 'existing-token-owner' })
  expect(await (await POST(request('lost-response'), ctx)).json()).toEqual({
    status: 'publishing',
    runId: 'existing-token-owner',
  })
  expect(await deps.store.getBatch(batch.id)).toMatchObject({
    approvalRun: { runId: 'existing-token-owner' },
  })
  expect(mocks.start).not.toHaveBeenCalled()
})

test('a live bound run keeps preflight and fresh acceptance locked even after the claim TTL', async () => {
  expect((await POST(request('live-command'), ctx)).status).toBe(202)
  mocks.status.mockResolvedValue('running')
  time = '2026-11-15T12:10:00Z'
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({
    canRetry: false,
    retryReason: 'locked',
  })
  expect(
    await (await POST(request('different-command'), ctx)).json()
  ).toMatchObject({ error: 'locked' })
  expect((await POST(request('live-command'), ctx)).status).toBe(202)
  expect(mocks.start).toHaveBeenCalledTimes(1)
})

test('GET never exposes Prepared Snapshot or Abandon during a healthy live run', async () => {
  expect((await POST(request('healthy-prepared'), ctx)).status).toBe(202)
  mocks.status.mockResolvedValue('running')
  const deps = mocks.deps()
  const accepted = (await deps.records.command('healthy-prepared'))!.command
  deps.snapshots.createOnly = async () => {
    throw new Error('upload pending')
  }
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({
    error: 'unavailable',
  })
  const preflight = await (await GET(request('preflight'), ctx)).json()
  expect(preflight.canAbandon).toBe(false)
  expect(preflight).not.toHaveProperty('prepared')
})

test('A: read-only GET discovers a healthy token owner without writing its claim', async () => {
  const deps = mocks.deps()
  await deps.records.accept({ ...command, commandId: 'healthy-unbound' }, time)
  time = '2026-11-15T12:10:00Z'
  mocks.status.mockResolvedValue('running')
  mocks.getHookByToken.mockResolvedValue({ runId: 'healthy-run' })
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({
    canRetry: false,
    retryReason: 'locked',
  })
  expect(await deps.records.command('healthy-unbound')).not.toHaveProperty(
    'runId'
  )
  expect(await (await POST(request('takeover'), ctx)).json()).toMatchObject({
    error: 'locked',
  })
  expect(await deps.store.getBatch(batch.id)).toMatchObject({
    publishCommand: { commandId: 'healthy-unbound' },
    approvalRun: { runId: 'old-stopped-run' },
  })
  expect(
    (await db.doc('publishCommandStops/healthy-unbound').get()).exists
  ).toBe(false)
})

test('B1: a start returning after TTL takeover cannot bind or pass its first Publish check', async () => {
  const deps = mocks.deps()
  const old = { ...command, commandId: 'late-start' }
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<{ runId: string }>()
  mocks.start.mockImplementationOnce(async () => {
    entered.resolve()
    return release.promise
  })
  const lateRequest = POST(request(old.commandId), ctx)
  await entered.promise
  time = '2026-11-15T12:02:01Z'
  expect((await POST(request('winner'), ctx)).status).toBe(202)
  release.resolve({ runId: 'late-run' })
  expect(await (await lateRequest).json()).toEqual({ error: 'superseded' })
  expect(await deps.records.bindRun(old, 'late-run', time)).toBe(false)
  expect(await deps.store.getBatch(batch.id)).toMatchObject({
    approvalRun: { runId: 'fresh-run' },
    publishCommand: { commandId: 'winner' },
  })
  expect(await publishBatch(deps, owner, old)).toMatchObject({
    error: 'superseded',
  })
  expect((await deps.pointer.read()).version).toBe(1)
})

test('B4: network replay keeps one claim, one run and one committed release', async () => {
  const deps = mocks.deps()
  await deps.records.accept({ ...command, commandId: 'network-intent' }, time)
  mocks.getHookByToken.mockResolvedValue({ runId: 'token-owner' })
  const first = await POST(request('network-intent'), ctx)
  expect(await first.json()).toEqual({
    status: 'publishing',
    runId: 'token-owner',
  })
  const accepted = (await deps.records.command('network-intent'))!.command
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({
    ok: true,
    value: { toVersion: 2 },
  })
  expect(await (await POST(request('network-intent'), ctx)).json()).toEqual({
    status: 'publishing',
    runId: 'token-owner',
  })
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({
    ok: true,
    value: { toVersion: 2 },
  })
  expect((await db.collection('publishCommands').get()).size).toBe(1)
  expect((await db.collection('publishRecords').get()).size).toBe(1)
  expect((await deps.pointer.read()).version).toBe(2)
  expect(mocks.start).not.toHaveBeenCalled()
})

test('C: a stale eligible preflight cannot override a newly live claim at acceptance', async () => {
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({
    canRetry: true,
  })
  expect((await POST(request('other-owner-click'), ctx)).status).toBe(202)
  mocks.status.mockResolvedValue('running')
  expect(
    await (await POST(request('stale-ui-click'), ctx)).json()
  ).toMatchObject({ error: 'locked' })
  expect((await db.collection('publishCommands').get()).size).toBe(1)
  expect(mocks.start).toHaveBeenCalledTimes(1)
})

test('a purged bound run permits takeover after TTL while a transient lookup stays locked and recovers', async () => {
  expect((await POST(request('old-bound'), ctx)).status).toBe(202)
  time = '2026-11-15T12:10:00Z'
  mocks.status.mockRejectedValueOnce(new Error('temporary lookup outage'))
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({
    canRetry: false,
    retryReason: 'locked',
  })
  mocks.status.mockResolvedValue('not_found')
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({
    canRetry: true,
  })
  expect((await POST(request('replacement-after-purge'), ctx)).status).toBe(202)
})

test('a missing claim document is recovered through its token or superseded when no run exists', async () => {
  const deps = mocks.deps()
  await deps.records.accept({ ...command, commandId: 'missing-claim' }, time)
  await db.doc('publishCommands/missing-claim').delete()
  mocks.status.mockResolvedValue('running')
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({
    canRetry: true,
  })
  expect((await POST(request('replace-missing'), ctx)).status).toBe(202)
  expect(
    (await db.doc('publishCommandStops/missing-claim').get()).get('reason')
  ).toBe('superseded')
})

test('a missing claim with a live token owner is reconstructed and remains locked', async () => {
  const deps = mocks.deps()
  await deps.records.accept(
    { ...command, commandId: 'missing-live-claim' },
    time
  )
  await db.doc('publishCommands/missing-live-claim').delete()
  mocks.status.mockResolvedValue('running')
  mocks.getHookByToken.mockResolvedValue({ runId: 'healthy-run' })
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({
    canRetry: false,
    retryReason: 'locked',
  })
  expect(await deps.records.command('missing-live-claim')).toBeNull()
  expect(await (await POST(request('cannot-steal'), ctx)).json()).toMatchObject(
    { error: 'locked' }
  )
  expect(await deps.records.command('missing-live-claim')).toBeNull()
})

test('URL metadata racing different bytes cannot advance the emulator pointer', async () => {
  const deps = mocks.deps()
  const url = deps.snapshots.downloadUrl
  const checksum = deps.snapshots.checksum
  let changed = false
  deps.snapshots.downloadUrl = async (version: number) => {
    const result = await url(version)
    changed = true
    return result
  }
  deps.snapshots.checksum = async (version: number) =>
    changed ? 'different-bytes' : checksum(version)
  expect((await POST(request('url-race'), ctx)).status).toBe(202)
  const accepted = (await deps.records.command('url-race'))!.command
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({
    error: 'version_taken',
  })
  expect((await deps.pointer.read()).version).toBe(1)
})

test('confirmation blocks a run queued from another workstation on another Batch in the catalog', async () => {
  const other = db.doc('reviewBatches/other-work')
  const run = db.doc('localPipelineRuns/other-work')
  try {
    expect(await (await GET(request('opening'), ctx)).json()).toMatchObject({
      canRetry: true,
    })
    await other.set({ ...batch, id: 'other-work', env })
    await run.set({
      batchId: 'other-work',
      env: 'development',
      status: 'queued',
    })
    expect(await (await POST(request('confirm'), ctx)).json()).toEqual({
      error: 'pipeline_busy',
      activeRuns: 1,
    })
    expect(mocks.start).not.toHaveBeenCalled()
    expect((await mocks.deps().pointer.read()).version).toBe(1)
    await run.update({ status: 'failed' })
    expect((await POST(request('confirm'), ctx)).status).toBe(202)
  } finally {
    await run.delete()
    await other.delete()
  }
})

test('Owner can confirm a release frozen from the shared draft without a separate approval', async () => {
  await db.doc('reviewBatches/batch').set({ ...release(), env })
  await seedReleaseDraft()
  const deps = mocks.deps()
  await db
    .doc('reviewBatches/batch/edits/one')
    .set({ plateId: 'one', fields: { tags: ['changed'] } })
  expect(await (await POST(request('draft-confirm'), ctx)).json()).toEqual({
    status: 'publishing',
    runId: 'fresh-run',
  })
  const accepted = (await deps.records.command('draft-confirm'))!.command
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({
    ok: true,
    value: { toVersion: 2 },
  })
  expect((await deps.pointer.read()).version).toBe(2)
})

test('publishing draft revision N freezes N from the change log and leaves the later edit in the draft', async () => {
  const deps = mocks.deps()
  const draft = newSharedDraft(env, 1, owner, time)
  expect(await deps.store.create(draft)).toBe('ok')
  const by = { uid: 'editor', name: 'Dana Curator' }
  const first = { ...draft, plateIds: ['one'], revision: 1 }
  expect(
    await deps.store.commit(draftId, 0, {
      batch: first,
      edit: tagEdit('one', ['reviewed']),
      by,
    })
  ).toBe('ok')
  // The Owner reviewed revision 1; an editor then changes another plate.
  expect(
    await deps.store.commit(draftId, 1, {
      batch: { ...first, plateIds: ['one', 'two'], revision: 2 },
      edit: tagEdit('two', ['after review']),
      by,
    })
  ).toBe('ok')
  expect((await POST(draftRequest(1, 'publish-one'), draftCtx)).status).toBe(
    202
  )
  const accepted = (await deps.records.command('publish-one'))!.command
  expect(accepted).toMatchObject({ confirmedDraftRevision: 0, revision: 1 })
  const frozen = await deps.store.readBatch(accepted.batchId)
  expect(frozen?.batch).toMatchObject({
    kind: 'release',
    source: { batchId: draftId, revision: 1 },
  })
  expect(frozen?.edits.map((edit: ProposedEdit) => edit.plateId)).toEqual([
    'one',
  ])
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({
    ok: true,
    value: { toVersion: 2 },
  })
  const published = await deps.snapshots.read(2)
  expect(
    published.plates.map((plate: { id: string; tags: string[] }) => [
      plate.id,
      plate.tags,
    ])
  ).toEqual([
    ['one', ['reviewed']],
    ['two', []],
  ])
  const after = await deps.store.readBatch(draftId)
  expect(after?.batch.revision).toBe(2)
  expect(after?.edits.map((edit: ProposedEdit) => edit.plateId).sort()).toEqual(
    ['one', 'two']
  )
})

test('a draft read while Publish is still finishing waits for the receipt, then drops only what shipped', async () => {
  const base = mocks.deps()
  /** Plates of a version this test published, or null for the fixture baseline. */
  const published = async (version: number): Promise<Plate[] | null> =>
    version === 1 ? null : (await base.snapshots.read(version)).plates
  const deps = {
    ...base,
    versionOrigin: firestoreVersionOrigin(db),
    /** Read a published version's plate so the rebase compares against live. */
    async baselineAtVersion(version: number, id: string) {
      const plates = await published(version)
      return plates
        ? (plates.find((plate) => plate.id === id) ?? null)
        : base.baselineAtVersion(version, id)
    },
    /** Read a published version's state plates. */
    async stateBaseline(version: number, state: string) {
      const plates = await published(version)
      return plates
        ? plates.filter((plate) => plate.state === state)
        : base.stateBaseline(version, state)
    },
  }
  mocks.deps.mockReturnValue(deps)
  const draft = newSharedDraft(env, 1, owner, time)
  expect(await deps.store.create(draft)).toBe('ok')
  const by = { uid: 'editor', name: 'Dana Curator' }
  const first = { ...draft, plateIds: ['one'], revision: 1 }
  await deps.store.commit(draftId, 0, {
    batch: first,
    edit: tagEdit('one', ['reviewed']),
    by,
  })
  await deps.store.commit(draftId, 1, {
    batch: { ...first, plateIds: ['one', 'two'], revision: 2 },
    edit: tagEdit('two', ['after review']),
    by,
  })
  expect((await POST(draftRequest(1, 'publish-mid'), draftCtx)).status).toBe(
    202
  )
  const accepted = (await deps.records.command('publish-mid'))!.command
  // Read the draft after the pointer moved but before the receipt is done.
  const curator = deps.curator
  let during: ReviewBatch | undefined
  deps.curator = {
    async writeStateOrders(
      ...args: Parameters<typeof curator.writeStateOrders>
    ) {
      during = await ensureDraft(deps, env, owner)
      return curator.writeStateOrders(...args)
    },
  }
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({
    ok: true,
    value: { toVersion: 2 },
  })
  expect((await deps.pointer.read()).version).toBe(2)
  expect(during).toMatchObject({ baselineVersion: 1, revision: 2 })
  expect(during?.lastPublish).toBeUndefined()

  const after = await ensureDraft(deps, env, owner)
  expect(after).toMatchObject({
    baselineVersion: 2,
    lastPublish: {
      revision: 1,
      version: 2,
      by: 'owner',
      byName: 'owner@example.com',
      at: time,
    },
  })
  const edits = (await deps.store.listEdits(draftId)).map(
    (edit: ProposedEdit) => [edit.plateId, edit.fields]
  )
  expect(edits).toEqual([['two', { tags: ['after review'] }]])
})

/**
 * Accept a Publish of draft revision 1, then have a curator correct the draft at
 * revision 2, as happens after a Publish attempt goes wrong.
 */
async function acceptThenCorrect(commandId: string) {
  const deps = mocks.deps()
  const draft = newSharedDraft(env, 1, owner, time)
  expect(await deps.store.create(draft)).toBe('ok')
  const by = { uid: 'editor', name: 'Dana Curator' }
  const first = { ...draft, plateIds: ['one'], revision: 1 }
  await deps.store.commit(draftId, 0, {
    batch: first,
    edit: tagEdit('one', ['reviewed']),
    by,
  })
  expect((await POST(draftRequest(1, commandId), draftCtx)).status).toBe(202)
  const accepted = (await deps.records.command(commandId))!.command
  await deps.store.commit(draftId, 1, {
    batch: { ...first, plateIds: ['one', 'two'], revision: 2 },
    edit: tagEdit('two', ['corrected']),
    by,
  })
  return { deps, accepted }
}
/** Read the Owner's Publish view of the shared draft. */
const draftView = async () =>
  (await GET(draftRequest(0, 'view'), draftCtx)).json()

test('a release whose run is live holds the draft Publish; once it fails before preparing a Snapshot, the corrected revision can publish', async () => {
  const { accepted } = await acceptThenCorrect('publish-fails-early')
  mocks.status.mockResolvedValue('running')
  expect(await draftView()).toMatchObject({
    draftRevision: 2,
    activeRelease: { id: accepted.batchId, revision: 1 },
    canPublish: false,
  })
  mocks.status.mockResolvedValue('failed')
  const view = await draftView()
  expect(view).toMatchObject({ draftRevision: 2, canPublish: true })
  expect(view.activeRelease).toBeUndefined()
  expect(view.interruptedRelease).toBeUndefined()
  expect(
    (await POST(draftRequest(2, 'publish-corrected'), draftCtx)).status
  ).toBe(202)
})

test('a release that stopped after preparing its Snapshot waits for recovery, and after Abandon the corrected revision can publish', async () => {
  const { deps, accepted } = await acceptThenCorrect('publish-prepared')
  const pointer = deps.pointer
  deps.pointer = {
    ...pointer,
    /** The run stops after the Snapshot is prepared, before the pointer moves. */
    advance: async () => {
      throw new Error('stopped')
    },
  }
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({
    ok: false,
  })
  deps.pointer = pointer
  mocks.status.mockResolvedValue('failed')
  const stopped = await draftView()
  expect(stopped).toMatchObject({
    interruptedRelease: { id: accepted.batchId, revision: 1 },
    canPublish: false,
  })
  expect(stopped.activeRelease).toBeUndefined()

  const abandoned = await abandon(
    new Request(`http://localhost/api/batches/${accepted.batchId}/abandon`, {
      method: 'POST',
      body: JSON.stringify({
        revision: accepted.revision,
        commandId: 'publish-prepared',
        reason: 'Curators corrected the draft.',
      }),
    }),
    { params: Promise.resolve({ id: accepted.batchId }) }
  )
  expect(abandoned.status).toBe(200)
  const view = await draftView()
  expect(view).toMatchObject({ draftRevision: 2, canPublish: true })
  expect(view.interruptedRelease).toBeUndefined()
  expect(view.activeRelease).toBeUndefined()
  expect(
    (await POST(draftRequest(2, 'publish-after-abandon'), draftCtx)).status
  ).toBe(202)
})

test('a stale Publish of a newer revision is refused while a release waits for Retry or Abandon, and the accepted command still replays', async () => {
  const { deps, accepted } = await acceptThenCorrect('publish-stuck')
  const pointer = deps.pointer
  deps.pointer = {
    ...pointer,
    /** The run stops after the Snapshot is prepared, before the pointer moves. */
    advance: async () => {
      throw new Error('stopped')
    },
  }
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({
    ok: false,
  })
  deps.pointer = pointer
  mocks.status.mockResolvedValue('failed')
  const releases = async () =>
    (await deps.store.list({ states: ['open', 'approved'] })).filter(
      (batch: ReviewBatch) => batch.kind === 'release'
    )
  const before = await releases()
  const starts = mocks.start.mock.calls.length

  // A tab opened before the run stopped still offers Publish for revision 2.
  const stale = await POST(draftRequest(2, 'publish-stale'), draftCtx)
  expect(stale.status).toBe(409)
  expect(await stale.json()).toMatchObject({ error: 'release_in_progress' })
  expect(await releases()).toEqual(before)
  expect(mocks.start.mock.calls.length).toBe(starts)
  expect(await deps.records.command('publish-stale')).toBeNull()

  // The accepted command itself is not held by its own release.
  const replay = await POST(draftRequest(1, 'publish-stuck'), draftCtx)
  expect(await replay.json()).not.toMatchObject({
    error: 'release_in_progress',
  })
})

/** POST a Publish command straight to one release, as its recovery page does. */
const releasePost = (id: string, revision: number, commandId: string) =>
  POST(
    new Request(`http://localhost/api/batches/${id}/publish`, {
      method: 'POST',
      body: JSON.stringify({ revision, commandId }),
    }),
    { params: Promise.resolve({ id }) }
  )

/**
 * Review deps whose catalog has v1 (the fixture) and a v2 where an outside change
 * retagged plate one.
 */
function versionedDeps() {
  const base = mocks.deps()
  const versions = new Map<number, Plate[]>([
    [1, snapshot.plates],
    [
      2,
      snapshot.plates.map((plate) =>
        plate.id === 'one' ? { ...plate, tags: ['live'] } : plate
      ),
    ],
  ])
  const deps = {
    ...base,
    /** Read a plate from the requested catalog version. */
    async baselineAtVersion(version: number, id: string) {
      return versions.get(version)?.find((plate) => plate.id === id) ?? null
    },
    /** Read a state's plates from the requested catalog version. */
    async stateBaseline(version: number, state: string) {
      return (versions.get(version) ?? []).filter(
        (plate) => plate.state === state
      )
    },
  }
  mocks.deps.mockReturnValue(deps)
  return deps
}

test('a stale freeze brought back by a rollback waits for the Owner at both entry points, then is superseded', async () => {
  const deps = versionedDeps()
  const draft = newSharedDraft(env, 1, owner, time)
  expect(await deps.store.create(draft)).toBe('ok')
  await deps.store.commit(draftId, 0, {
    batch: { ...draft, plateIds: ['one'], revision: 1 },
    edit: tagEdit('one', ['reviewed']),
    by: { uid: 'editor', name: 'Dana Curator' },
  })
  // A Publish froze revision 1 on v1, but its command was never accepted.
  const frozen = await freezeRelease(deps, env, owner, 1)
  if (!frozen.ok) throw new Error(frozen.error)
  // An outside change retags the same plate, then a repair points live back at v1.
  await db.doc('config/catalog').set({ version: 2 })
  await ensureDraft(deps, env, owner)
  await db.doc('config/catalog').set({ version: 1 })
  expect((await ensureDraft(deps, env, owner)).conflicts?.length).toBeTruthy()
  const starts = mocks.start.mock.calls.length

  const refused = async (error: string, suffix: string) => {
    for (const response of [
      await POST(draftRequest(1, `stale-draft-${suffix}`), draftCtx),
      await releasePost(frozen.value.id, 0, `stale-release-${suffix}`),
    ]) {
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error })
    }
    expect(mocks.start.mock.calls.length).toBe(starts)
    expect(await deps.records.command(`stale-draft-${suffix}`)).toBeNull()
    expect(await deps.records.command(`stale-release-${suffix}`)).toBeNull()
    expect((await deps.store.getBatch(frozen.value.id))?.state).toBe('open')
  }
  await refused('draft_conflicts', 'conflicts')
  // Once the Owner keeps the draft's values, the old freeze is still behind the draft.
  const reviewed = (await deps.store.getBatch(draftId))!
  expect(
    await keepDraftValues(deps, owner, {
      batchId: draftId,
      revision: reviewed.revision,
    })
  ).toMatchObject({ ok: true })
  await refused('superseded_revision', 'kept')
})

test('two Publish requests racing on one draft accept and start only one revision', async () => {
  const deps = mocks.deps()
  const draft = newSharedDraft(env, 1, owner, time)
  expect(await deps.store.create(draft)).toBe('ok')
  const by = { uid: 'editor', name: 'Dana Curator' }
  const first = { ...draft, plateIds: ['one'], revision: 1 }
  await deps.store.commit(draftId, 0, {
    batch: first,
    edit: tagEdit('one', ['reviewed']),
    by,
  })
  // Hold the first request right after it found no release holding the draft.
  const list = deps.store.list
  let paused = false
  let reached!: () => void
  let resume!: () => void
  const atPause = new Promise<void>((resolve) => (reached = resolve))
  const resumed = new Promise<void>((resolve) => (resume = resolve))
  deps.store.list = async (filter: { states?: string[] }) => {
    const result = await list(filter)
    if (!paused && filter.states?.includes('approved')) {
      paused = true
      reached()
      await resumed
    }
    return result
  }
  const stale = POST(draftRequest(1, 'race-one'), draftCtx)
  await atPause
  await deps.store.commit(draftId, 1, {
    batch: { ...first, plateIds: ['one', 'two'], revision: 2 },
    edit: tagEdit('two', ['second']),
    by,
  })
  expect((await POST(draftRequest(2, 'race-two'), draftCtx)).status).toBe(202)
  resume()
  const response = await stale
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: 'release_in_progress' })
  expect(mocks.start).toHaveBeenCalledTimes(1)
  expect(await deps.records.command('race-one')).toBeNull()
  expect(await deps.records.command('race-two')).not.toBeNull()
})

test('undoing a deletion waits while its release runs, and is accepted once that release fails before preparing a Snapshot', async () => {
  const deps = mocks.deps()
  const draft = newSharedDraft(env, 1, owner, time)
  expect(await deps.store.create(draft)).toBe('ok')
  const editor = {
    uid: 'editor',
    name: 'Dana Curator',
    role: 'editor',
  } as const
  await deps.store.commit(draftId, 0, {
    batch: { ...draft, plateIds: ['one'], revision: 1 },
    edit: { ...tagEdit('one', []), fields: { deleted: true } },
    by: editor,
  })
  expect((await POST(draftRequest(1, 'publish-delete'), draftCtx)).status).toBe(
    202
  )
  /** The Dashboard's Undo delete: restore the plate from its current state. */
  const undo = async () => {
    const plate = (await deps.baselineAtVersion(1, 'one'))!
    const edit = await deps.store.getEdit(draftId, 'one')
    return proposeEdit(deps, editor, {
      batchId: draftId,
      plateId: 'one',
      baseRevision: plateRevision({ ...plate, ...edit?.fields }),
      fields: { deleted: false },
    })
  }

  mocks.status.mockResolvedValue('running')
  expect(await undo()).toMatchObject({
    ok: false,
    error: 'invalid_state',
    reasons: [expect.stringContaining('Revision 1')],
  })
  // The run fails before preparing a Snapshot, so there is nothing to abandon.
  mocks.status.mockResolvedValue('failed')
  expect(await undo()).toMatchObject({ ok: true })
  expect(await deps.store.getEdit(draftId, 'one')).toBeNull()
})

test('deletion undo and Publish acceptance are serialized in either commit order', async () => {
  const deps = mocks.deps()
  const draft = newSharedDraft(env, 1, owner, time)
  const editor = { uid: 'editor', name: 'Curator', role: 'editor' } as const
  const seed = async () => {
    await deps.store.create(draft)
    await deps.store.commit(draftId, 0, {
      batch: { ...draft, plateIds: ['one'], revision: 1 },
      edit: { ...tagEdit('one', []), fields: { deleted: true } },
      by: editor,
    })
  }
  const target = {
    batchId: draftId,
    plateId: 'one',
    batchRevision: 1,
    target: 'deleted',
  } as const
  await seed()
  expect(await discardPlateChanges(deps, editor, target)).toMatchObject({
    ok: true,
  })
  expect(await deps.store.getEdit(draftId, 'one')).toBeNull()
  const losingPublish = await POST(
    draftRequest(1, 'publish-after-undo'),
    draftCtx
  )

  expect(await deps.records.command('publish-after-undo')).toBeNull()

  await db.recursiveDelete(db.doc(`reviewBatches/${draftId}`))
  await deleteReleases()
  await seed()
  mocks.status.mockResolvedValue('running')
  let acceptedStatus: number | undefined
  const concurrent = {
    ...deps,
    store: {
      ...deps.store,
      commit: async (...args: Parameters<typeof deps.store.commit>) => {
        acceptedStatus ??= (
          await POST(draftRequest(1, 'publish-before-undo'), draftCtx)
        ).status
        return deps.store.commit(...args)
      },
    },
  }
  const losingUndo = await discardPlateChanges(concurrent, editor, target)

  expect(acceptedStatus).toBe(202)
  expect(losingUndo).toMatchObject({ ok: false, error: 'invalid_state' })
  expect(await deps.store.getEdit(draftId, 'one')).toMatchObject({
    fields: { deleted: true },
  })
  expect(losingPublish.status).toBe(409)
  expect(await losingPublish.json()).toMatchObject({
    error: 'superseded_revision',
  })
})

test('Retry starts a stopped Publish for a legacy approved copy with a deletion', async () => {
  const original = db.doc('reviewBatches/legacy-copy-source')
  const copy = db.doc(`reviewBatches/${batch.id}`)
  await db
    .batch()
    .set(original, { ...batch, id: original.id, env })
    .update(copy, {
      source: { batchId: original.id, revision: batch.revision },
    })
    .set(copy.collection('edits').doc('one'), {
      ...tagEdit('one', []),
      fields: { deleted: true },
    })
    .commit()
  try {
    mocks.status.mockResolvedValue('failed')
    expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({
      canRetry: true,
    })
    const response = await POST(request('retry-legacy-deletion'), ctx)
    expect({
      status: response.status,
      body: await response.json(),
    }).toMatchObject({
      status: 202,
      body: { status: 'publishing', runId: 'fresh-run' },
    })
  } finally {
    await original.delete()
  }
})

test('an Editor cannot confirm a Publish', async () => {
  mocks.actor.mockResolvedValue({
    ok: false,
    response: Response.json({ error: 'forbidden' }, { status: 403 }),
  })
  expect((await POST(request('not-owner'), ctx)).status).toBe(403)
  expect(mocks.start).not.toHaveBeenCalled()
})

test('one Owner confirmation freezes and publishes a 1,000-Plate shared draft in one Snapshot', async () => {
  const deps = mocks.deps()
  const plates = Array.from({ length: 1000 }, (_, index) => ({
    id: `CA.plate-${index}`,
    state: 'CA',
    slug: `plate-${index}`,
    displayName: `Plate ${index}`,
    image: `plate-${index}.webp`,
    tags: ['before'],
  }))
  let draft = newSharedDraft(env, 1, owner, time)
  expect(await deps.store.create(draft)).toBe('ok')
  const readSnapshot = deps.snapshots.read
  deps.snapshots.read = async (version: number) =>
    version === 1 ? { version: 1, plates } : readSnapshot(version)

  for (let offset = 0; offset < plates.length; offset += 200) {
    const slice = plates.slice(offset, offset + 200)
    const next = {
      ...draft,
      revision: draft.revision + 1,
      plateIds: [...draft.plateIds, ...slice.map((plate) => plate.id)],
    }
    expect(
      await deps.store.commit(draftId, draft.revision, {
        batch: next,
        edits: slice.map((plate) => tagEdit(plate.id, ['after'])),
        by: { uid: 'editor', name: 'Dana Curator' },
      })
    ).toBe('ok')
    draft = next
  }

  expect(
    (await POST(draftRequest(draft.revision, 'state-sized-confirm'), draftCtx))
      .status
  ).toBe(202)
  const accepted = (await deps.records.command('state-sized-confirm'))!.command
  expect((await deps.store.readBatch(accepted.batchId))?.edits.length).toBe(
    1000
  )
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({
    ok: true,
    value: { toVersion: 2 },
  })
  expect((await deps.pointer.read()).version).toBe(2)
  expect((await deps.snapshots.read(2)).plates).toEqual(
    plates.map((plate) => ({ ...plate, tags: ['after'] }))
  )
  expect(await deps.store.getBatch(accepted.batchId)).toMatchObject({
    kind: 'release',
    state: 'published',
    source: { batchId: draftId, revision: draft.revision },
  })
})

test('a release holding only pipeline audit metadata is insufficient to publish a new Snapshot', async () => {
  await db.doc('reviewBatches/batch').set({ ...release(), env })
  await seedReleaseDraft()
  await db
    .doc('reviewBatches/batch/edits/one')
    .set({ plateId: 'one', fields: {}, pipelineRunIds: ['completed-run'] })
  expect(await (await GET(request('opening'), ctx)).json()).toMatchObject({
    canConfirmDraft: false,
    retryReason: 'empty_batch',
  })
  const result = await POST(request('audit-only'), ctx)
  expect(result.status).toBe(409)
  expect(await result.json()).toMatchObject({ error: 'empty_batch' })
  expect(mocks.start).not.toHaveBeenCalled()
  expect((await mocks.deps().pointer.read()).version).toBe(1)
})

test('the publish gate follows Batch environment across legacy worker namespaces and Batch query pages', async () => {
  const catalogBatches = Array.from({ length: 31 }, (_, index) =>
    db.doc(`reviewBatches/scoped-${String(index).padStart(2, '0')}`)
  )
  const other = db.doc('reviewBatches/other-preview')
  const job = db.doc('jobs/legacy-other-scope')
  const otherJob = db.doc('jobs/other-preview')
  const requestPublish = request('scope-confirmation')
  try {
    const writes = db.batch()
    for (const batchRef of catalogBatches) writes.set(batchRef, { env })
    writes.set(other, { env: 'preview:unrelated' })
    writes.set(job, {
      batchId: catalogBatches.at(-1)!.id,
      env: 'preview:worker-device',
      state: 'claimed',
    })
    writes.set(otherJob, { batchId: other.id, env, state: 'queued' })
    await writes.commit()
    // Only the claimed job on this environment's Batch counts toward the gate.
    expect(await (await POST(requestPublish, ctx)).json()).toEqual({
      error: 'pipeline_busy',
      activeRuns: 1,
    })
    await job.update({ state: 'completed' })
    expect((await POST(request('scope-confirmation'), ctx)).status).toBe(202)
  } finally {
    const writes = db.batch()
    for (const ref of [...catalogBatches, other, job, otherJob])
      writes.delete(ref)
    await writes.commit()
  }
})

test('a submitted legacy Batch with a waiting review workflow can no longer be confirmed', async () => {
  const deps = mocks.deps()
  const supersede = vi.fn(async () => undefined)
  deps.supersedeRun = supersede
  const submitted = {
    ...batch,
    state: 'submitted' as const,
    approval: null,
    approvalRun: { runId: 'waiting-for-review', revision: batch.revision },
  }
  await db.doc('reviewBatches/batch').set({ ...submitted, env })
  await db
    .doc('reviewBatches/batch/edits/one')
    .set({ plateId: 'one', fields: { tags: ['confirmed draft'] } })
  mocks.status.mockResolvedValue('running')

  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({
    canConfirmDraft: false,
  })
  const response = await POST(request('confirm-submitted'), ctx)
  expect(response.status).toBe(410)
  expect(await response.json()).toMatchObject({ error: 'batches_retired' })
  expect(supersede).not.toHaveBeenCalled()
  expect(mocks.resumeHook).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
  expect(await deps.store.getBatch(batch.id)).toMatchObject({
    state: 'submitted',
    revision: batch.revision,
  })
  expect((await deps.pointer.read()).version).toBe(1)
})
