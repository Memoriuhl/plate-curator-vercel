import { expect, test } from 'vitest'
import { copyBatch, type CopyDeps } from '../../lib/review/copy'
import { createMemoryStore } from '../../lib/review/memory-store'
import { batchDetail } from '../../lib/review/queries'
import { plateRevision } from '../../lib/review/revision'
import { publishBatch } from '../../lib/publish/publish'
import { submitBatch, approveBatch } from '../../lib/review/batch'
import { batch, fixture, owner, snapshot } from '../publish/fixture'

function setup() {
  let head = 2
  const store = createMemoryStore([{ ...batch, stateOrders: { CA: ['two', 'one'] }, approvalRun: { runId: 'old', revision: 1 }, publishRequestedAt: 'old' }], () => head)
  const fresh = { version: 2, plates: snapshot.plates.map(plate => ({ ...plate, tags: ['intervening'], variantOfPlateId: 'two' })) }
  const d: CopyDeps = { store, head: async () => head, snapshot: async () => fresh, env: 'test', now: () => '2026-11-16T12:00:00Z' }
  const input = { sourceId: batch.id, sourceRevision: 2, targetVersion: 2 }
  return { d, store, input, fresh, setHead: (version: number) => { head = version } }
}

test('copies editable proposals and clears atomically into an unapproved open Batch with fresh before values', async () => {
  const f = setup()
  await f.store.commit(batch.id, 2, { batch: (await f.store.getBatch(batch.id))!, edit: { plateId: 'one', fields: { tags: ['proposed'], templateFamily: 'family', templateRole: 'variant', variantOfPlateId: null, description: null, isStandard: false }, baseRevision: 'old', resultRevision: 'old-result', authorId: 'editor', updatedAt: 'old' } })
  const original = await f.store.readBatch(batch.id)
  const result = await copyBatch(f.d, owner, f.input)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const copy = result.value
  expect(copy).toMatchObject({ state: 'open', revision: 0, baselineVersion: 2, approval: null, createdBy: owner.uid, source: { batchId: batch.id, revision: 2 }, stateOrders: { CA: ['two', 'one'] }, baselineOrders: { CA: ['one', 'two'] } })
  for (const key of ['approvalRun', 'publishRequestedAt', 'publishReservation']) expect(copy).not.toHaveProperty(key)
  expect(f.store.signalRevision(copy.id)).toBe(0)
  expect(await f.store.listEdits(copy.id)).toEqual([expect.objectContaining({
    fields: original!.edits[0].fields,
    baseRevision: plateRevision(f.fresh.plates[0]),
    resultRevision: plateRevision({ ...f.fresh.plates[0], ...original!.edits[0].fields }),
  })])
  expect(await f.store.readBatch(batch.id)).toEqual(original)
  const detail = await batchDetail({ ...fixture().deps, store: f.store, baselineAtVersion: async (version, id) => version === 2 ? f.fresh.plates.find(plate => plate.id === id) ?? null : null }, copy.id)
  expect(detail).toMatchObject({ ok: true, value: { plates: expect.arrayContaining([expect.objectContaining({ baseline: expect.objectContaining({ tags: ['intervening'] }), proposed: expect.objectContaining({ tags: ['proposed'], variantOfPlateId: null }), edit: expect.objectContaining({ baseRevision: plateRevision(f.fresh.plates[0]), resultRevision: expect.any(String) }) })]) } })
  const deps = fixture().deps
  deps.store = f.store
  expect(await publishBatch(deps, owner, { batchId: copy.id, revision: 0 })).toEqual({ ok: false, error: 'invalid_state' })
  const [replay, duplicate] = await Promise.all([copyBatch(f.d, owner, f.input), copyBatch(f.d, { ...owner, uid: 'another-owner' }, f.input)])
  expect(replay).toEqual(result)
  expect(duplicate).toEqual(result)
  f.setHead(3)
  expect(await copyBatch(f.d, owner, f.input)).toEqual(result)
  expect(await f.store.list({})).toHaveLength(2)
})

test('only the Owner can copy a known approved source revision', async () => {
  const f = setup()
  expect(await copyBatch(f.d, { ...owner, role: 'editor' }, f.input)).toEqual({ ok: false, error: 'forbidden' })
  expect(await copyBatch(f.d, owner, { ...f.input, sourceId: 'missing' })).toEqual({ ok: false, error: 'not_found' })
  expect(await copyBatch(f.d, owner, { ...f.input, sourceRevision: 1 })).toEqual({ ok: false, error: 'superseded_revision' })
  await f.store.commit(batch.id, 2, { batch: { ...batch, state: 'published' } })
  expect(await copyBatch(f.d, owner, f.input)).toEqual({ ok: false, error: 'invalid_state' })
  expect(await f.store.list({})).toHaveLength(1)
})

test('a copy needs fresh submission and approval, and replay never resets that approval or baseline', async () => {
  const f = setup()
  const result = await copyBatch(f.d, owner, f.input)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const deps = { ...fixture().deps, store: f.store }
  expect(await approveBatch(deps, owner, result.value.id, 0)).toEqual({ ok: false, error: 'invalid_state' })
  expect(await submitBatch(deps, owner, result.value.id, 0)).toMatchObject({ ok: true, value: { state: 'submitted', revision: 1 } })
  const approved = await approveBatch(deps, owner, result.value.id, 1)
  expect(approved).toMatchObject({ ok: true, value: { state: 'approved', revision: 2, baselineVersion: 2, approval: { revision: 1, by: owner.uid } } })
  f.setHead(3)
  expect(await copyBatch(f.d, owner, f.input)).toEqual(approved)
  expect(await f.store.list({})).toHaveLength(2)
})

test.each(['missing plate', 'missing variant', 'changed inventory'])('rejects %s without creating a partial copy', async kind => {
  const f = setup()
  if (kind === 'missing plate') f.fresh.plates.shift()
  if (kind === 'changed inventory') f.fresh.plates.push({ ...f.fresh.plates[0], id: 'three' })
  if (kind === 'missing variant') await f.store.commit(batch.id, 2, { batch: (await f.store.getBatch(batch.id))!, edit: { plateId: 'one', fields: { variantOfPlateId: 'gone' }, baseRevision: '', resultRevision: '', authorId: 'editor', updatedAt: '' } })
  const original = await f.store.readBatch(batch.id)
  expect(await copyBatch(f.d, owner, f.input)).toMatchObject({ ok: false, error: 'incompatible', reasons: expect.arrayContaining([expect.any(String)]) })
  expect(await f.store.list({})).toHaveLength(1)
  expect(await f.store.readBatch(batch.id)).toEqual(original)
})

test.each(['before read', 'before commit', 'source revision', 'source status'])('checks a race at %s', async race => {
  const f = setup()
  if (race === 'before read') f.setHead(3)
  else f.d.snapshot = async () => {
    if (race === 'before commit') f.setHead(3)
    else await f.store.commit(batch.id, 2, { batch: { ...batch, ...(race === 'source revision' ? { revision: 3 } : { state: 'published' }) } })
    return f.fresh
  }
  expect(await copyBatch(f.d, owner, f.input)).toMatchObject({ ok: false, error: race.startsWith('before') ? 'head_moved' : race === 'source revision' ? 'superseded_revision' : 'invalid_state', ...(race.startsWith('before') ? { liveVersion: 3 } : {}) })
  expect(await f.store.list({})).toHaveLength(1)
})

test.each([
  ['missing', ['one']],
  ['extra', ['one', 'two', 'other']],
  ['duplicate', ['one', 'one']],
  ['wrong jurisdiction', ['one', 'other']],
] as const)('copy rejects a %s State order without changing the source or creating a target', async (kind, order) => {
  const f = setup()
  if (kind === 'wrong jurisdiction') f.fresh.plates.push({ ...f.fresh.plates[0], id: 'other', state: 'NY' })
  const source = (await f.store.getBatch(batch.id))!
  await f.store.commit(batch.id, 2, { batch: { ...source, stateOrders: { CA: [...order] } } })
  const original = await f.store.readBatch(batch.id)
  expect(await copyBatch(f.d, owner, f.input)).toEqual({ ok: false, error: 'incompatible', reasons: ['State order no longer matches Jurisdiction: CA'] })
  expect(await f.store.readBatch(batch.id)).toEqual(original)
  expect(await f.store.list({})).toHaveLength(1)
})
