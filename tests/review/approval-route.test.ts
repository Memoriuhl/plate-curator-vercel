import { beforeEach, expect, test, vi } from 'vitest'
import { POST as submit } from '../../app/api/batches/[id]/submit/route'
import { POST as approve } from '../../app/api/batches/[id]/approve/route'
import { POST as publish } from '../../app/api/batches/[id]/publish/route'
import { GET } from '../../app/api/batches/[id]/run/route'
import { PATCH } from '../../app/api/batches/[id]/plates/[plateId]/route'
import { PUT } from '../../app/api/batches/[id]/state-order/[state]/route'
import { createMemoryStore } from '../../lib/review/memory-store'
import { plateRevision } from '../../lib/review/revision'
import { HookConflictError } from 'workflow/errors'
import type { ReviewBatch, ReviewDeps } from '../../lib/review/types'

const mocks = vi.hoisted(() => ({ currentActor: vi.fn(), currentActiveOwner: vi.fn(), reviewDeps: vi.fn(), publishDeps: vi.fn(), publishAllowed: () => true, controlRead: vi.fn(), start: vi.fn(), resumeHook: vi.fn(), getRun: vi.fn(), publishBatch: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ cacheTag: vi.fn(), cacheLife: vi.fn(), revalidateTag: vi.fn() }))
vi.mock('../../lib/server/context', async importOriginal => ({ ...await importOriginal<typeof import('../../lib/server/context')>(), ...mocks }))
vi.mock('workflow/api', () => mocks)
vi.mock('../../lib/publish/publish', () => ({ publishBatch: mocks.publishBatch }))
const ctx = { params: Promise.resolve({ id: 'batch' }) }
const baseline = { id: 'one', state: 'AK', slug: 'one', displayName: 'One', image: '', tags: [] }
const batch: ReviewBatch = { id: 'batch', name: 'Review', createdBy: 'editor', createdByName: null, createdAt: '', state: 'open', revision: 0, baselineVersion: 7, plateIds: ['one'], stateOrders: {}, approval: null }
function request(body: unknown) {
  return new Request('http://localhost/api/batches/batch', { method: 'POST', body: JSON.stringify(body) })
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.currentActiveOwner.mockResolvedValue({ ok: true, actor: { uid: 'owner', email: 'owner@example.com', authorityEpoch: 5, role: 'owner' } })
  mocks.controlRead.mockResolvedValue({ paused: false, generation: 1 })
  mocks.publishDeps.mockReturnValue({ control: { read: mocks.controlRead }, pointer: { read: async () => ({ version: 7 }) }, records: { command: async () => null, get: async () => null, accept: async (command: unknown) => ({ command }), bindRun: async () => true } })
  mocks.currentActor.mockResolvedValue({ ok: true, actor: { uid: 'owner', name: null, role: 'owner' } })
  mocks.start.mockResolvedValue({ runId: 'run' })
  mocks.resumeHook.mockResolvedValue({ runId: 'run' })
  mocks.getRun.mockReturnValue({ status: Promise.resolve('running') })
  mocks.reviewDeps.mockReturnValue({ store: createMemoryStore([batch]), baselineAtVersion: async () => baseline, baseline: async () => baseline, stateBaseline: async () => [baseline], now: () => '2026-11-16T12:00:00.000Z', supersedeRun: vi.fn(async () => {}) } satisfies ReviewDeps)
})

test('submit stores the run, approve resumes approval, and Publish only resumes the command', async () => {
  expect((await submit(request({ revision: 0 }), ctx)).status).toBe(200)
  expect(mocks.start).toHaveBeenCalledWith(expect.any(Function), ['batch', 1], { experimental_hook: { token: 'approval:batch:1' } })
  expect(await mocks.reviewDeps().store.getBatch('batch')).toMatchObject({ approvalRun: { runId: 'run', revision: 1 } })
  expect((await approve(request({ revision: 1 }), ctx)).status).toBe(200)
  expect(mocks.resumeHook).toHaveBeenCalledWith('approval:batch:1', { by: 'owner' })
  expect((await publish(request({ revision: 2 }), ctx)).status).toBe(202)
  expect(mocks.resumeHook).toHaveBeenCalledWith('publish:batch:2', { ownerUid: 'owner', requestedBy: { uid: 'owner', email: 'owner@example.com', authorityEpoch: 5 }, generation: 1, commandId: expect.any(String) })
  expect(await mocks.reviewDeps().store.getBatch('batch')).toMatchObject({ publishRequestedAt: '2026-11-16T12:00:00.000Z', publishRequestedBy: { uid: 'owner', email: 'owner@example.com', authorityEpoch: 5 } })
  expect(mocks.publishBatch).not.toHaveBeenCalled()
})

test('a rejected Publish command is not recorded as publishing', async () => {
  mocks.reviewDeps().store = createMemoryStore([{ ...batch, state: 'approved', approval: { revision: 0, by: 'owner', at: '' } }])
  mocks.resumeHook.mockRejectedValueOnce(new Error('not waiting'))
  expect((await publish(request({ revision: 0 }), ctx)).status).toBe(409)
  expect((await mocks.reviewDeps().store.getBatch('batch')).publishRequestedAt).toBeUndefined()
})

test('a stopped approval run starts a new command run instead of resuming its ended hook', async () => {
  mocks.reviewDeps().store = createMemoryStore([{ ...batch, state: 'approved', revision: 2, approval: { revision: 1, by: 'owner', at: '' }, approvalRun: { runId: 'old', revision: 1 } }])
  mocks.getRun.mockReturnValue({ status: Promise.resolve('completed'), returnValue: Promise.resolve({ outcome: 'publish_failed', error: 'paused' }) })
  expect((await publish(request({ revision: 2, commandId: 'fresh-click' }), ctx)).status).toBe(202)
  expect(mocks.resumeHook).not.toHaveBeenCalled()
  expect(mocks.start).toHaveBeenCalledWith(expect.any(Function), ['batch', 2, expect.objectContaining({ commandId: 'fresh-click' })], expect.objectContaining({ experimental_hook: expect.objectContaining({ token: 'publish-command:fresh-click' }) }))
})

test('duplicate fresh requests return their persisted run even after the Batch published', async () => {
  const command = { batchId: 'batch', revision: 2, commandId: 'fresh-click', generation: 1, requestedBy: { uid: 'owner', email: 'owner@example.com', authorityEpoch: 5 } }
  mocks.publishDeps().records.command = async () => ({ command, runId: 'fresh-run' })
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await publish(request({ revision: 2, commandId: 'fresh-click' }), ctx)
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ status: 'publishing', runId: 'fresh-run' })
  }
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.resumeHook).not.toHaveBeenCalled()
})

test('a replayed command cannot be taken by a different requester', async () => {
  mocks.publishDeps().records.command = async () => ({ command: { batchId: 'batch', revision: 2, requestedBy: { uid: 'other', email: 'other@example.com', authorityEpoch: 0 } }, runId: 'other-run' })
  expect((await publish(request({ revision: 2, commandId: 'fresh-click' }), ctx)).status).toBe(409)
  expect(mocks.start).not.toHaveBeenCalled()
})

test('a concurrent duplicate start returns the run owning the command token', async () => {
  const command = { batchId: 'batch', revision: 2, commandId: 'fresh-click', generation: 1, requestedBy: { uid: 'owner', email: 'owner@example.com', authorityEpoch: 5 } }
  mocks.publishDeps().records.command = async () => ({ command })
  mocks.start.mockResolvedValueOnce({ runId: 'one-run' }).mockRejectedValueOnce(new HookConflictError('publish-command:fresh-click', 'one-run'))
  const responses = await Promise.all([publish(request({ revision: 2, commandId: 'fresh-click' }), ctx), publish(request({ revision: 2, commandId: 'fresh-click' }), ctx)])
  for (const response of responses) {
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ status: 'publishing', runId: 'one-run' })
  }
})

test('unauthenticated fresh clicks are refused before command lookup', async () => {
  mocks.currentActiveOwner.mockResolvedValue({ ok: false, response: Response.json({ error: 'unauthenticated' }, { status: 401 }) })
  expect((await publish(request({ revision: 2, commandId: 'fresh-click' }), ctx)).status).toBe(401)
  expect(mocks.publishDeps).not.toHaveBeenCalled()
})

test.each(['submitted', 'approved'] as const)('plate and order edits supersede a %s run', async state => {
  for (const kind of ['plate', 'order']) {
    const previous = { ...batch, state, approvalRun: { runId: 'run', revision: 0 } }
    mocks.reviewDeps().store = createMemoryStore([previous])
    const response = kind === 'plate'
      ? await PATCH(request({ baseRevision: plateRevision(baseline), fields: { description: 'Updated' } }), { params: Promise.resolve({ id: 'batch', plateId: 'one' }) })
      : await PUT(request({ batchRevision: 0, order: ['one'] }), { params: Promise.resolve({ id: 'batch', state: 'AK' }) })
    expect(response.status).toBe(200)
    expect(mocks.reviewDeps().supersedeRun).toHaveBeenCalledWith(previous)
    expect(await mocks.reviewDeps().store.getBatch('batch')).toMatchObject({ state: 'open', revision: 1, approvalRun: previous.approvalRun })
  }
})

test('run read requires the Owner and returns missing batches', async () => {
  mocks.currentActor.mockResolvedValueOnce({ ok: true, actor: { role: 'editor' } })
  const forbidden = await GET(request(null), ctx)
  expect(forbidden.status).toBe(403)
  expect(await forbidden.json()).toEqual({ error: 'forbidden' })
  const missing = await GET(request(null), { params: Promise.resolve({ id: 'missing' }) })
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({ error: 'not_found' })
})

test('run read returns nulls for an unsubmitted batch', async () => {
  expect(await (await GET(request(null), ctx)).json()).toEqual({ runId: null, phase: null, outcome: null, updatedAt: null })
  expect(mocks.getRun).not.toHaveBeenCalled()
})

test.each(['running', 'completed'])('reads %s runs without waiting on an unfinished result', async status => {
  mocks.reviewDeps().store = createMemoryStore([{ ...batch, state: 'submitted', approvalRun: { runId: 'run', revision: 0 } }])
  const result = vi.fn(() => Promise.resolve({ outcome: 'published', version: 8 }))
  mocks.getRun.mockReturnValue({ status: Promise.resolve(status), createdAt: Promise.resolve(new Date('2026-11-16T12:00:00Z')), get returnValue() { return result() } })
  expect(await (await GET(request(null), ctx)).json()).toEqual({ runId: 'run', phase: status === 'completed' ? 'published' : 'waiting-for-approval', outcome: status === 'completed' ? { version: 8 } : null, updatedAt: '2026-11-16T12:00:00.000Z' })
  expect(result).toHaveBeenCalledTimes(status === 'completed' ? 1 : 0)
})

test('run metadata survives a concurrent approval committing a previously read batch', async () => {
  const store = createMemoryStore([{ ...batch, state: 'submitted', revision: 1 }])
  const before = (await store.getBatch('batch'))!
  expect(await store.recordRun('batch', 1, 'run')).toBe(true)
  await store.commit('batch', 1, { batch: { ...before, state: 'approved', revision: 2, approval: { revision: 1, by: 'owner', at: '' } } })
  expect(await store.getBatch('batch')).toMatchObject({ state: 'approved', approvalRun: { runId: 'run', revision: 1 } })
  const approved = (await store.getBatch('batch'))!
  expect(await store.requestPublish('batch', 2, 'now')).toBe(true)
  await store.commit('batch', 2, { batch: { ...approved, state: 'published', revision: 3 } })
  expect(await store.getBatch('batch')).toMatchObject({ state: 'published', approvalRun: { runId: 'run', revision: 1 }, publishRequestedAt: 'now' })
})

test('run metadata writes cannot overwrite edits or a newer submission', async () => {
  const store = createMemoryStore([{ ...batch, state: 'submitted', revision: 3, approvalRun: { runId: 'new', revision: 3 } }])
  expect(await store.recordRun('batch', 1, 'old')).toBe(false)
  expect(await store.requestPublish('batch', 2, 'now')).toBe(false)
  expect(await store.getBatch('batch')).toMatchObject({ state: 'submitted', revision: 3, approvalRun: { runId: 'new', revision: 3 } })
})

test('a stale preflight returns reviewed and live versions without accepting a command', async () => {
  mocks.reviewDeps().store = createMemoryStore([{ ...batch, state: 'approved', revision: 2 }])
  mocks.publishDeps.mockReturnValue({ control: { read: mocks.controlRead }, pointer: { read: async () => ({ version: 8 }) }, records: { get: async () => null } })
  const response = await publish(request({ revision: 2 }), ctx)
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: 'stale_baseline', reviewedVersion: 7, liveVersion: 8 })
  expect(mocks.resumeHook).not.toHaveBeenCalled()
  expect((await mocks.reviewDeps().store.getBatch('batch')).publishRequestedAt).toBeUndefined()
})

test('paused wins over stale; Resume restores stale-baseline rejection', async () => {
  mocks.reviewDeps().store = createMemoryStore([{ ...batch, state: 'approved', revision: 2 }])
  mocks.publishDeps.mockReturnValue({ control: { read: mocks.controlRead }, pointer: { read: async () => ({ version: 8 }) }, records: { get: async () => null } })
  mocks.controlRead.mockResolvedValueOnce({ paused: true, generation: 2 })
  expect(await (await publish(request({ revision: 2 }), ctx)).json()).toEqual({ error: 'paused' })
  expect(await (await publish(request({ revision: 2 }), ctx)).json()).toEqual({ error: 'stale_baseline', reviewedVersion: 7, liveVersion: 8 })
  expect(mocks.resumeHook).not.toHaveBeenCalled()
})

test('missing and unavailable control refuse command acceptance', async () => {
  mocks.reviewDeps().store = createMemoryStore([{ ...batch, state: 'approved', revision: 2 }])
  mocks.controlRead.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline'))
  expect(await (await publish(request({ revision: 2 }), ctx)).json()).toEqual({ error: 'publish_not_enabled' })
  expect((await publish(request({ revision: 2 }), ctx)).status).toBe(503)
  expect(mocks.resumeHook).not.toHaveBeenCalled()
})

test.each(['editor', 'removed', 'bootstrap'])('Publish requires current active membership before reading controls: %s', async () => {
  mocks.currentActiveOwner.mockResolvedValue({ ok: false, response: Response.json({ error: 'forbidden' }, { status: 403 }) })
  expect((await publish(request({ revision: 2 }), ctx)).status).toBe(403)
  expect(mocks.controlRead).not.toHaveBeenCalled()
  expect(mocks.resumeHook).not.toHaveBeenCalled()
})

test('invalid Publish bodies and missing Batches are rejected before the paused control is read', async () => {
  mocks.controlRead.mockResolvedValue({ paused: true, generation: 2 })
  expect((await publish(request({}), ctx)).status).toBe(400)
  expect((await publish(request({ revision: 2 }), { params: Promise.resolve({ id: 'missing' }) })).status).toBe(404)
  expect(mocks.controlRead).not.toHaveBeenCalled()
})
