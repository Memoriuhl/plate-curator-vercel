import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { HookNotFoundError } from 'workflow/errors'
import { POST, GET } from '../app/api/batches/[id]/publish/route'
import { POST as markReviewed, GET as recentReview } from '../app/api/batches/[id]/review-checkpoint/route'
import { firestorePublishControl, firestorePublishCurator, firestorePublishLock, firestorePublishPointer, firestorePublishRecords } from '../lib/publish/firestore'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import { publishBatch } from '../lib/publish/publish'
import { verifyPreparedObject } from '../lib/publish/object'
import { batch, command, fixture, owner } from '../tests/publish/fixture'
import { db } from './setup'

const mocks = vi.hoisted(() => ({ deps: vi.fn(), actor: vi.fn(), start: vi.fn(), getHookByToken: vi.fn(), resumeHook: vi.fn(), status: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('workflow/api', () => ({ start: mocks.start, getHookByToken: mocks.getHookByToken, resumeHook: mocks.resumeHook }))
vi.mock('../workflows/approval', () => ({ publishRun: async () => {} }))
vi.mock('../lib/server/context', () => ({
  currentActiveOwner: mocks.actor, publishAllowed: () => true, publishDeps: mocks.deps, reviewDeps: mocks.deps,
  requesterAuthority: (actor: { uid: string; email: string; authorityEpoch: number }) => ({ uid: actor.uid, email: actor.email, authorityEpoch: actor.authorityEpoch }),
}))

const env = 'retry-route'
const initialTime = '2026-11-15T12:00:00Z'
let time = initialTime
const ctx = { params: Promise.resolve({ id: batch.id }) }
const request = (commandId: string) => new Request('http://localhost/api/batches/batch/publish', { method: 'POST', body: JSON.stringify({ revision: 2, commandId }) })

beforeEach(async () => {
  vi.resetAllMocks()
  time = initialTime
  await db.recursiveDelete(db.collection('publishCommands'))
  await db.recursiveDelete(db.collection('publishCommandStops'))
  await db.recursiveDelete(db.collection('publishRecords'))
  await db.doc('locks/publish').delete()
  await db.recursiveDelete(db.doc('reviewBatches/batch'))
  await db.doc('reviewBatches/batch').set({ ...batch, env, approvalRun: { runId: 'old-stopped-run', revision: 1 } })
  await db.doc('curatorLive/retry-route/batchRevisions/batch').delete()
  await db.doc('config/catalog').set({ version: 1 })
  await db.doc('config/publishControl').set({ paused: false, generation: 1, changedBy: { uid: 'owner', email: 'owner@example.com' }, changedAt: time })
  await db.doc('members/owner%40example.com').set({ uid: 'owner', role: 'owner', status: 'active', authorityEpoch: 0 })
  mocks.actor.mockResolvedValue({ ok: true, actor: { ...owner, email: 'owner@example.com', authorityEpoch: 0 } })
  mocks.status.mockResolvedValue('completed')
  mocks.getHookByToken.mockRejectedValue(new HookNotFoundError('missing'))
  mocks.start.mockResolvedValue({ runId: 'fresh-run' })
  const f = fixture()
  mocks.deps.mockReturnValue({ ...f.deps, now: () => time, control: firestorePublishControl(db), store: firestoreReviewStore(db, env),
    records: firestorePublishRecords(db, env, { runStatus: mocks.status, findRun: async commandId => {
      try { const run = await mocks.getHookByToken(`publish-command:${commandId}`); return { runId: run.runId, status: await mocks.status(run.runId) } } catch (error) { if (HookNotFoundError.is(error)) return null; throw error }
    } }), lock: firestorePublishLock(db, env),
    pointer: firestorePublishPointer(db, env, record => verifyPreparedObject(f.deps.snapshots, record)), curator: firestorePublishCurator(db, env) })
})

afterAll(async () => {
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
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({ canRetry: false, retryReason: 'locked' })
  time = '2026-11-15T12:02:01Z'
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({ canRetry: true, retryReason: null })
  expect((await POST(request('new-click'), ctx)).status).toBe(202)
  expect((await db.doc('publishCommandStops/failed-start').get()).get('reason')).toBe('superseded')
  expect(await mocks.deps().store.getBatch(batch.id)).toMatchObject({ approvalRun: { runId: 'fresh-run' }, publishCommand: { commandId: 'new-click' } })
})

test('a fresh run ending without a stop can be replaced and the old command remains fenced', async () => {
  expect((await POST(request('ended-run'), ctx)).status).toBe(202)
  const deps = mocks.deps()
  const accepted = (await deps.records.command('ended-run'))!.command
  deps.snapshots.read = async () => ({ version: 99, plates: [] })
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({ error: 'invalid_snapshot' })
  expect((await db.doc('publishCommandStops/ended-run').get()).exists).toBe(false)
  mocks.status.mockResolvedValue('failed')
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({ canRetry: true })
  expect((await POST(request('replacement'), ctx)).status).toBe(202)
  expect((await db.doc('publishCommandStops/ended-run').get()).get('reason')).toBe('superseded')
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({ error: 'superseded' })
})

test.each(['pause', 'approval', 'baseline'])('unbound replay rechecks %s before starting any run', async changed => {
  const deps = mocks.deps()
  expect(await deps.records.accept({ ...command, commandId: 'replay' }, time)).toMatchObject({ ok: true })
  if (changed === 'pause') await db.doc('config/publishControl').update({ paused: true, generation: 2 })
  if (changed === 'approval') await db.doc('reviewBatches/batch').update({ approval: null })
  if (changed === 'baseline') await db.doc('config/catalog').update({ version: 2 })
  expect((await POST(request('replay'), ctx)).status).toBe(409)
  expect(mocks.start).not.toHaveBeenCalled()
})

test('lost start response finds the token owner and binds the Batch without a duplicate start', async () => {
  const deps = mocks.deps()
  await deps.records.accept({ ...command, commandId: 'lost-response' }, time)
  mocks.getHookByToken.mockResolvedValue({ runId: 'existing-token-owner' })
  expect(await (await POST(request('lost-response'), ctx)).json()).toEqual({ status: 'publishing', runId: 'existing-token-owner' })
  expect(await deps.store.getBatch(batch.id)).toMatchObject({ approvalRun: { runId: 'existing-token-owner' } })
  expect(mocks.start).not.toHaveBeenCalled()
})

test('a live bound run keeps preflight and fresh acceptance locked even after the claim TTL', async () => {
  expect((await POST(request('live-command'), ctx)).status).toBe(202)
  mocks.status.mockResolvedValue('running')
  time = '2026-11-15T12:10:00Z'
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({ canRetry: false, retryReason: 'locked' })
  expect(await (await POST(request('different-command'), ctx)).json()).toMatchObject({ error: 'locked' })
  expect((await POST(request('live-command'), ctx)).status).toBe(202)
  expect(mocks.start).toHaveBeenCalledTimes(1)
})

test('GET never exposes Prepared Snapshot or Abandon during a healthy live run', async () => {
  expect((await POST(request('healthy-prepared'), ctx)).status).toBe(202)
  mocks.status.mockResolvedValue('running')
  const deps = mocks.deps()
  const accepted = (await deps.records.command('healthy-prepared'))!.command
  deps.snapshots.createOnly = async () => { throw new Error('upload pending') }
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({ error: 'unavailable' })
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
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({ canRetry: false, retryReason: 'locked' })
  expect(await deps.records.command('healthy-unbound')).not.toHaveProperty('runId')
  expect(await (await POST(request('takeover'), ctx)).json()).toMatchObject({ error: 'locked' })
  expect(await deps.store.getBatch(batch.id)).toMatchObject({ publishCommand: { commandId: 'healthy-unbound' }, approvalRun: { runId: 'old-stopped-run' } })
  expect((await db.doc('publishCommandStops/healthy-unbound').get()).exists).toBe(false)
})

test('B1: a start returning after TTL takeover cannot bind or pass its first Publish check', async () => {
  const deps = mocks.deps()
  const old = { ...command, commandId: 'late-start' }
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<{ runId: string }>()
  mocks.start.mockImplementationOnce(async () => { entered.resolve(); return release.promise })
  const lateRequest = POST(request(old.commandId), ctx)
  await entered.promise
  time = '2026-11-15T12:02:01Z'
  expect((await POST(request('winner'), ctx)).status).toBe(202)
  release.resolve({ runId: 'late-run' })
  expect(await (await lateRequest).json()).toEqual({ error: 'superseded' })
  expect(await deps.records.bindRun(old, 'late-run', time)).toBe(false)
  expect(await deps.store.getBatch(batch.id)).toMatchObject({ approvalRun: { runId: 'fresh-run' }, publishCommand: { commandId: 'winner' } })
  expect(await publishBatch(deps, owner, old)).toMatchObject({ error: 'superseded' })
  expect((await deps.pointer.read()).version).toBe(1)
})

test('B4: network replay keeps one claim, one run and one committed release', async () => {
  const deps = mocks.deps()
  await deps.records.accept({ ...command, commandId: 'network-intent' }, time)
  mocks.getHookByToken.mockResolvedValue({ runId: 'token-owner' })
  const first = await POST(request('network-intent'), ctx)
  expect(await first.json()).toEqual({ status: 'publishing', runId: 'token-owner' })
  const accepted = (await deps.records.command('network-intent'))!.command
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({ ok: true, value: { toVersion: 2 } })
  expect(await (await POST(request('network-intent'), ctx)).json()).toEqual({ status: 'publishing', runId: 'token-owner' })
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({ ok: true, value: { toVersion: 2 } })
  expect((await db.collection('publishCommands').get()).size).toBe(1)
  expect((await db.collection('publishRecords').get()).size).toBe(1)
  expect((await deps.pointer.read()).version).toBe(2)
  expect(mocks.start).not.toHaveBeenCalled()
})

test('C: a stale eligible preflight cannot override a newly live claim at acceptance', async () => {
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({ canRetry: true })
  expect((await POST(request('other-owner-click'), ctx)).status).toBe(202)
  mocks.status.mockResolvedValue('running')
  expect(await (await POST(request('stale-ui-click'), ctx)).json()).toMatchObject({ error: 'locked' })
  expect((await db.collection('publishCommands').get()).size).toBe(1)
  expect(mocks.start).toHaveBeenCalledTimes(1)
})

test('a purged bound run permits takeover after TTL while a transient lookup stays locked and recovers', async () => {
  expect((await POST(request('old-bound'), ctx)).status).toBe(202)
  time = '2026-11-15T12:10:00Z'
  mocks.status.mockRejectedValueOnce(new Error('temporary lookup outage'))
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({ canRetry: false, retryReason: 'locked' })
  mocks.status.mockResolvedValue('not_found')
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({ canRetry: true })
  expect((await POST(request('replacement-after-purge'), ctx)).status).toBe(202)
})

test('a missing claim document is recovered through its token or superseded when no run exists', async () => {
  const deps = mocks.deps()
  await deps.records.accept({ ...command, commandId: 'missing-claim' }, time)
  await db.doc('publishCommands/missing-claim').delete()
  mocks.status.mockResolvedValue('running')
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({ canRetry: true })
  expect((await POST(request('replace-missing'), ctx)).status).toBe(202)
  expect((await db.doc('publishCommandStops/missing-claim').get()).get('reason')).toBe('superseded')
})

test('a missing claim with a live token owner is reconstructed and remains locked', async () => {
  const deps = mocks.deps()
  await deps.records.accept({ ...command, commandId: 'missing-live-claim' }, time)
  await db.doc('publishCommands/missing-live-claim').delete()
  mocks.status.mockResolvedValue('running')
  mocks.getHookByToken.mockResolvedValue({ runId: 'healthy-run' })
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({ canRetry: false, retryReason: 'locked' })
  expect(await deps.records.command('missing-live-claim')).toBeNull()
  expect(await (await POST(request('cannot-steal'), ctx)).json()).toMatchObject({ error: 'locked' })
  expect(await deps.records.command('missing-live-claim')).toBeNull()
})

test('URL metadata racing different bytes cannot advance the emulator pointer', async () => {
  const deps = mocks.deps()
  const url = deps.snapshots.downloadUrl
  const checksum = deps.snapshots.checksum
  let changed = false
  deps.snapshots.downloadUrl = async (version: number) => { const result = await url(version); changed = true; return result }
  deps.snapshots.checksum = async (version: number) => changed ? 'different-bytes' : checksum(version)
  expect((await POST(request('url-race'), ctx)).status).toBe(202)
  const accepted = (await deps.records.command('url-race'))!.command
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({ error: 'version_taken' })
  expect((await deps.pointer.read()).version).toBe(1)
})

test('confirmation blocks a run queued from another workstation on another Batch in the catalog', async () => {
  const other = db.doc('reviewBatches/other-work')
  const run = db.doc('localPipelineRuns/other-work')
  try {
    expect(await (await GET(request('opening'), ctx)).json()).toMatchObject({ canRetry: true })
    await other.set({ ...batch, id: 'other-work', env })
    await run.set({ batchId: 'other-work', env: 'development', status: 'queued' })
    expect(await (await POST(request('confirm'), ctx)).json()).toEqual({ error: 'pipeline_busy' })
    expect(mocks.start).not.toHaveBeenCalled()
    expect((await mocks.deps().pointer.read()).version).toBe(1)
    await run.update({ status: 'failed' })
    expect((await POST(request('confirm'), ctx)).status).toBe(202)
  } finally {
    await run.delete()
    await other.delete()
  }
})

test('Owner can confirm the current draft revision without a separate approval', async () => {
  await db.doc('reviewBatches/batch').set({ ...batch, env, state: 'open', revision: 2, approval: null })
  const deps = mocks.deps()
  expect(await (await POST(request('draft-confirm'), ctx)).json()).toEqual({ status: 'publishing', runId: 'fresh-run' })
  const accepted = (await deps.records.command('draft-confirm'))!.command
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({ ok: true, value: { toVersion: 2 } })
  expect((await deps.pointer.read()).version).toBe(2)
})

test('the same Owner sees intervening edits and must confirm the latest revision', async () => {
  const deps = mocks.deps()
  const current = { ...batch, state: 'open' as const, approval: null }
  await db.doc('reviewBatches/batch').set({ ...current, env })
  expect((await markReviewed(request('checkpoint'), ctx)).status).toBe(200)
  expect(await (await GET(request('opening'), ctx)).json()).toMatchObject({ confirmation: { revision: 2, since: 2, plateCount: 0 } })
  await deps.store.commit(batch.id, current.revision, {
    batch: { ...current, revision: 3 }, by: { uid: 'editor', name: 'Dana Curator' },
    edit: { plateId: batch.plateIds[0], fields: { tags: ['blue'] }, baseRevision: 'before', resultRevision: 'after', updatedAt: time, authorId: 'editor' },
  })
  expect(await (await POST(request('old-confirm'), ctx)).json()).toMatchObject({
    error: 'superseded_revision', confirmation: { revision: 3, since: 2, plateCount: 1, contributors: ['Dana Curator'] },
  })
  expect(mocks.start).not.toHaveBeenCalled()
  const changes = await recentReview(new Request('http://localhost/api/batches/batch/review-checkpoint?since=2'), ctx)
  expect(await changes.json()).toEqual({ plateIds: [batch.plateIds[0]] })
  const revised = new Request('http://localhost/api/batches/batch/publish', { method: 'POST', body: JSON.stringify({ revision: 3, commandId: 'confirmed-current' }) })
  expect((await POST(revised, ctx)).status).toBe(202)
  const accepted = (await deps.records.command('confirmed-current'))!.command
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({ ok: true, value: { toVersion: 2 } })
  expect((await deps.snapshots.read(2)).plates.find((plate: { id: string }) => plate.id === batch.plateIds[0])?.tags).toEqual(['blue'])
})

test('an Editor cannot confirm a Publish', async () => {
  mocks.actor.mockResolvedValue({ ok: false, response: Response.json({ error: 'forbidden' }, { status: 403 }) })
  expect((await POST(request('not-owner'), ctx)).status).toBe(403)
  expect(mocks.start).not.toHaveBeenCalled()
})

test('an active Batch stays open for incremental draft writes until its run settles', async () => {
  const { submitBatch } = await import('../lib/review/batch')
  await db.doc('reviewBatches/batch').set({ ...batch, env, state: 'open', approval: null })
  const run = db.doc('localPipelineRuns/active-batch')
  try {
    await run.set({ batchId: batch.id, status: 'running' })
    expect(await submitBatch(mocks.deps(), owner, batch.id, batch.revision)).toEqual({ ok: false, error: 'pipeline_busy' })
    expect(await mocks.deps().store.getBatch(batch.id)).toMatchObject({ state: 'open', revision: batch.revision })
    await run.update({ status: 'failed' })
    expect(await submitBatch(mocks.deps(), owner, batch.id, batch.revision)).toMatchObject({ ok: true, value: { state: 'submitted' } })
  } finally {
    await run.delete()
  }
})

test('one Owner confirmation publishes the full 1,000-Plate draft in one Snapshot', async () => {
  const deps = mocks.deps()
  const plates = Array.from({ length: 1000 }, (_, index) => ({
    id: `CA.plate-${index}`, state: 'CA', slug: `plate-${index}`, displayName: `Plate ${index}`, image: `plate-${index}.webp`, tags: ['before'],
  }))
  let draft = { ...batch, state: 'open' as const, approval: null, revision: 0, plateIds: plates.map(plate => plate.id) }
  await db.doc('reviewBatches/batch').set({ ...draft, env })
  const readSnapshot = deps.snapshots.read
  deps.snapshots.read = async (version: number) => version === 1 ? { version: 1, plates } : readSnapshot(version)

  for (let offset = 0; offset < plates.length; offset += 200) {
    const edits = plates.slice(offset, offset + 200).map(plate => ({
      plateId: plate.id, fields: { tags: ['after'] }, baseRevision: 'before', resultRevision: 'after', updatedAt: time, authorId: 'editor',
    }))
    const next = { ...draft, revision: draft.revision + 1 }
    expect(await deps.store.commit(batch.id, draft.revision, { batch: next, edits, by: { uid: 'editor', name: 'Dana Curator' } })).toBe('ok')
    draft = next
  }

  const confirmed = new Request('http://localhost/api/batches/batch/publish', { method: 'POST', body: JSON.stringify({ revision: draft.revision, commandId: 'state-sized-confirm' }) })
  expect((await POST(confirmed, ctx)).status).toBe(202)
  const accepted = (await deps.records.command('state-sized-confirm'))!.command
  expect(await publishBatch(deps, owner, accepted)).toMatchObject({ ok: true, value: { toVersion: 2 } })
  expect((await deps.pointer.read()).version).toBe(2)
  expect((await deps.snapshots.read(2)).plates).toEqual(plates.map(plate => ({ ...plate, tags: ['after'] })))
  expect(await deps.store.getBatch(batch.id)).toMatchObject({ state: 'published', revision: draft.revision + 2 })
})
