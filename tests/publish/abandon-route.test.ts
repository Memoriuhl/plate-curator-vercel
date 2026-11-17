import { beforeEach, expect, test, vi } from 'vitest'
import { POST } from '../../app/api/batches/[id]/abandon/route'
import { batch, command, fixture, owner } from './fixture'
import { publishBatch } from '../../lib/publish/publish'

const mocks = vi.hoisted(() => ({ currentActiveOwner: vi.fn(), publishAllowed: vi.fn(), publishDeps: vi.fn() }))
vi.mock('../../lib/server/context', () => mocks)
const ctx = { params: Promise.resolve({ id: batch.id }) }
const request = (body: unknown = { revision: 2, commandId: command.commandId, reason: 'Choose another Batch' }) => new Request('http://localhost/api/batches/batch/abandon', { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.currentActiveOwner.mockResolvedValue({ ok: true, actor: { ...owner, ...command.requestedBy } })
  mocks.publishAllowed.mockReturnValue(true)
})

test.each([401, 403])('abandon requires current active Owner authority: %s', async status => {
  mocks.currentActiveOwner.mockResolvedValue({ ok: false, response: Response.json({ error: status === 401 ? 'unauthenticated' : 'forbidden' }, { status }) })
  expect((await POST(request(), ctx)).status).toBe(status)
  expect(mocks.publishDeps).not.toHaveBeenCalled()
})

test('Owner abandons while paused and a duplicate returns the same disposition', async () => {
  const f = fixture()
  f.deps.snapshots.createOnly = async () => { throw new Error('upload interrupted') }
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ error: 'unavailable' })
  f.setControl({ paused: true, generation: 2, changedBy: command.requestedBy, changedAt: f.deps.now() })
  await f.deps.control.check(command, f.deps.now())
  mocks.publishDeps.mockReturnValue(f.deps)
  const first = await POST(request(), ctx)
  expect(first.status).toBe(200)
  expect(await (await POST(request(), ctx)).json()).toEqual(await first.json())
})

test.each([{}, { revision: 2, commandId: '../bad', reason: 'x' }, { revision: 2, commandId: 'ok', reason: '' }])('invalid abandonment body is rejected', async body => {
  expect((await POST(request(body), ctx)).status).toBe(400)
})

test('legacy stopped receipts can be abandoned and duplicate requests find the archive', async () => {
  const f = fixture()
  f.records.set('batch@2', { id: 'batch@2', batchId: batch.id, revision: 2, fromVersion: 1, toVersion: 2, blobSha256: 'legacy', state: 'started' })
  await f.deps.control.check({ batchId: batch.id, revision: 2 }, f.deps.now())
  mocks.publishDeps.mockReturnValue(f.deps)
  const body = { revision: 2, commandId: 'batch@2:legacy', reason: 'Legacy cleanup' }
  const first = await POST(request(body), ctx)
  expect(first.status).toBe(200)
  expect(await (await POST(request(body), ctx)).json()).toEqual(await first.json())
})
