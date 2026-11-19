import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { HookNotFoundError } from 'workflow/errors'
import { POST, GET } from '../app/api/batches/[id]/publish/route'
import {
  firestorePublishControl,
  firestorePublishCurator,
  firestorePublishLock,
  firestorePublishPointer,
  firestorePublishRecords,
} from '../lib/publish/firestore'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import { newSharedDraft } from '../lib/review/draft'
import { sharedDraftId } from '../lib/review/draft-id'
import type { ProposedEdit, ReviewBatch } from '../lib/review/types'
import { publishBatch } from '../lib/publish/publish'
import { verifyPreparedObject } from '../lib/publish/object'
import { batch, command, fixture, owner } from '../tests/publish/fixture'
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
  mocks.deps.mockReturnValue({
    ...f.deps,
    /** Read the controlled test clock so state and lease timestamps advance deterministically. */ now: () =>
      time,
    control: firestorePublishControl(db),
    store: firestoreReviewStore(db, env),
    records: firestorePublishRecords(db, env, {
      runStatus: mocks.status,
      /** Control discovery by command token when the fixture has no recorded workflow ID. */ findRun:
        async (commandId) => {
          try {
            const run = await mocks.getHookByToken(
              `publish-command:${commandId}`
            )
            return { runId: run.runId, status: await mocks.status(run.runId) }
          } catch (error) {
            if (HookNotFoundError.is(error)) return null
            throw error
          }
        },
    }),
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
