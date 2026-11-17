import { expect, test, vi } from 'vitest'
import { publishBatch } from '../../lib/publish/publish'
import { batch, command, fixture, owner } from './fixture'
import { approveBatch, proposeEdit, submitBatch } from '../../lib/review/batch'
import { plateRevision } from '../../lib/review/revision'
import { snapshot } from './fixture'

const enabled = { paused: false, generation: 1, changedBy: { uid: 'owner', email: 'owner@example.com' }, changedAt: '2026-11-16T12:00:00Z' }

test.each([null, { ...enabled, paused: true }])('control %j stops before preparation', async control => {
  const f = fixture()
  f.setControl(control)
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: false, error: control ? 'paused' : 'publish_not_enabled' })
  expect([...f.blobs.keys()]).toEqual([1])
  expect(await f.deps.store.getBatch(batch.id)).toEqual(batch)
  expect(f.lease()).toBeNull()
})

test.each([false, true])('pause after upload stays terminal, resume before commit: %s', async resume => {
  const f = fixture()
  const upload = f.deps.snapshots.createOnly
  f.deps.snapshots.createOnly = async (...args) => {
    const result = await upload(...args)
    f.setControl({ ...enabled, paused: !resume, generation: resume ? 3 : 2 })
    return result
  }
  const error = resume ? 'superseded' : 'paused'
  expect(await publishBatch(f.deps, owner, command)).toEqual({ ok: false, error })
  expect(f.pointer().version).toBe(1)
  expect(f.records.get('batch@2')).toMatchObject({ state: 'uploaded' })
  expect(f.blobs.has(2)).toBe(true)
  expect(f.lease()).toBeNull()
  f.setControl({ ...enabled, generation: 3 })
  expect(await publishBatch(f.deps, owner, command)).toEqual({ ok: false, error })
  expect(await f.deps.store.getBatch(batch.id)).toEqual(batch)
})

test('committed first reconciles while paused without advancing twice', async () => {
  const f = fixture()
  const advance = f.deps.pointer.advance
  const spy = vi.fn(async (...args: Parameters<typeof advance>) => {
    await advance(...args)
    f.setControl({ ...enabled, paused: true, generation: 2 })
    f.deps.control.check = async () => { throw new Error('control unavailable after commit') }
    throw new Error('lost response')
  })
  f.deps.pointer.advance = spy
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ error: 'unavailable' })
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true, value: { toVersion: 2 } })
  expect(await publishBatch(f.deps, owner, command)).toMatchObject({ ok: true })
  expect(spy).toHaveBeenCalledTimes(1)
})

test.each([false, true])('legacy command without a generation is superseded (paused: %s)', async paused => {
  const f = fixture()
  f.setControl({ ...enabled, paused })
  expect(await publishBatch(f.deps, owner, { batchId: batch.id, revision: 2 })).toEqual({ ok: false, error: 'superseded' })
  expect(f.blobs.has(2)).toBe(false)
})

test('a pause before preparation stays terminal after Resume', async () => {
  const f = fixture()
  f.setControl({ ...enabled, paused: true, generation: 2 })
  expect(await publishBatch(f.deps, owner, command)).toEqual({ ok: false, error: 'paused' })
  f.setControl({ ...enabled, generation: 3 })
  expect(await publishBatch(f.deps, owner, command)).toEqual({ ok: false, error: 'paused' })
  expect(f.blobs.has(2)).toBe(false)
  expect(await publishBatch(f.deps, owner, { ...command, commandId: 'new-click', generation: 3 })).toMatchObject({ ok: true, value: { generation: 3, commandId: 'new-click' } })
})

test('unavailable authority cannot prepare or advance', async () => {
  const f = fixture()
  f.deps.control.check = async () => { throw new Error('unavailable') }
  expect(await publishBatch(f.deps, owner, command)).toEqual({ ok: false, error: 'unavailable' })
  expect(f.pointer().version).toBe(1)
  expect(f.blobs.has(2)).toBe(false)
})

test('Editors keep editing and submitting and Owners approving while paused', async () => {
  const f = fixture({ ...batch, state: 'open', revision: 0, approval: null })
  f.setControl({ ...enabled, paused: true, generation: 2 })
  const editor = { uid: batch.createdBy, name: null, role: 'editor' } as const
  expect(await proposeEdit(f.deps, editor, { batchId: batch.id, plateId: 'one', baseRevision: plateRevision(snapshot.plates[0]), fields: { description: 'Still curating' } })).toMatchObject({ ok: true })
  expect(await submitBatch(f.deps, editor, batch.id, 1)).toMatchObject({ ok: true })
  expect(await approveBatch(f.deps, owner, batch.id, 2)).toMatchObject({ ok: true })
  expect(await f.deps.store.getBatch(batch.id)).toMatchObject({ state: 'approved', revision: 3 })
})
