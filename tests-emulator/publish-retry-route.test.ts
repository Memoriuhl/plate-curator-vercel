import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { HookNotFoundError } from 'workflow/errors'
import { POST, GET } from '../app/api/batches/[id]/publish/route'
import { firestorePublishControl, firestorePublishCurator, firestorePublishLock, firestorePublishPointer, firestorePublishRecords } from '../lib/publish/firestore'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import { publishBatch } from '../lib/publish/publish'
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
    pointer: firestorePublishPointer(db, env), curator: firestorePublishCurator(db, env) })
})

afterAll(async () => {
  await db.recursiveDelete(db.collection('publishCommands'))
  await db.recursiveDelete(db.collection('publishCommandStops'))
  await db.recursiveDelete(db.collection('publishRecords'))
  await db.doc('reviewBatches/batch').delete()
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

test('A: TTL discovers and binds an unbound healthy token owner instead of stealing its claim', async () => {
  const deps = mocks.deps()
  await deps.records.accept({ ...command, commandId: 'healthy-unbound' }, time)
  time = '2026-11-15T12:10:00Z'
  mocks.status.mockResolvedValue('running')
  mocks.getHookByToken.mockResolvedValue({ runId: 'healthy-run' })
  expect(await (await GET(request('preflight'), ctx)).json()).toMatchObject({ canRetry: false, retryReason: 'locked' })
  expect(await deps.records.command('healthy-unbound')).toMatchObject({ runId: 'healthy-run' })
  expect(await (await POST(request('takeover'), ctx)).json()).toMatchObject({ error: 'locked' })
  expect(await deps.store.getBatch(batch.id)).toMatchObject({ publishCommand: { commandId: 'healthy-unbound' }, approvalRun: { runId: 'healthy-run' } })
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
