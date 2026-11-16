import { expect, test, vi } from 'vitest'
import { orderedStatePlates } from '../../lib/catalog/order'
import { proposeEdit, reorderState } from '../../lib/review/batch'
import { plateRevision } from '../../lib/review/revision'
import { batchDetail } from '../../lib/review/queries'
import { createMemoryStore } from '../../lib/review/memory-store'
import type { ReviewBatch, ReviewDeps } from '../../lib/review/types'

const editor = { uid: 'editor', name: null, role: 'editor' } as const
const plates = ['AK.two', 'AK.one', 'AK.three'].map(id => ({ id, state: 'AK', slug: id, displayName: id, image: '', tags: [] }))
const batch: ReviewBatch = {
  id: 'batch', name: 'Order', createdBy: editor.uid, createdByName: null, createdAt: '',
  state: 'open', revision: 4, baselineVersion: 7, plateIds: ['AK.one'], stateOrders: {}, approval: null,
}
function setup(overrides: Partial<ReviewBatch> = {}) {
  const store = createMemoryStore([{ ...batch, ...overrides }])
  const stateBaseline = vi.fn(async () => plates)
  const deps: ReviewDeps = { store, stateBaseline, baselineAtVersion: async (_version, id) => plates.find(plate => plate.id === id) ?? null, baseline: async id => plates.find(plate => plate.id === id) ?? null, now: () => '' }
  return { deps, store, stateBaseline }
}

test('reordering saves the full state from the pinned version without expanding field-edit membership', async () => {
  const { deps, store, stateBaseline } = setup()
  const order = ['AK.three', 'AK.two', 'AK.one']
  expect(await reorderState(deps, editor, { batchId: 'batch', state: 'AK', batchRevision: 4, order })).toEqual({
    ok: true, value: { ...batch, revision: 5, stateOrders: { AK: order }, baselineOrders: { AK: plates.map(plate => plate.id) } },
  })
  expect(stateBaseline).toHaveBeenCalledWith(7, 'AK')
  expect(await store.getBatch('batch')).toMatchObject({ plateIds: ['AK.one'], stateOrders: { AK: order } })
})

test.each(['open', 'submitted', 'approved'] as const)('creator and owner reorder a %s batch and clear approval', async state => {
  for (const actor of [editor, { ...editor, uid: 'owner', role: 'owner' as const }]) {
    const { deps } = setup({ state, approval: { revision: 3, by: 'owner', at: '' }, stateOrders: { CA: ['CA.one'] } })
    expect(await reorderState(deps, actor, { batchId: 'batch', state: 'AK', batchRevision: 4, order: plates.map(p => p.id) })).toMatchObject({
      ok: true, value: { revision: 5, state: 'open', approval: null, stateOrders: { CA: ['CA.one'], AK: plates.map(p => p.id) } },
    })
  }
})

test.each([[], ['AK.one'], ['AK.one', 'AK.one', 'AK.two'], ['AK.one', 'AK.two', 'CA.other'], ['AK.one', 'AK.two', 'AK.three', 'AK.extra']].map(order => [order]))('rejects a non-permutation %j without mutation', async order => {
  const { deps, store } = setup()
  expect(await reorderState(deps, editor, { batchId: 'batch', state: 'AK', batchRevision: 4, order })).toEqual({ ok: false, error: 'invalid_state' })
  expect(await store.getBatch('batch')).toEqual(batch)
})

test('checks existence, rights, revision, state and commit races', async () => {
  const { deps, store, stateBaseline } = setup()
  const input = { batchId: 'batch', state: 'AK', batchRevision: 4, order: plates.map(p => p.id) }
  expect(await reorderState(deps, editor, { ...input, batchId: 'missing' })).toEqual({ ok: false, error: 'not_found' })
  expect(await reorderState(deps, { ...editor, uid: 'other' }, input)).toEqual({ ok: false, error: 'forbidden' })
  expect(await reorderState(deps, editor, { ...input, batchRevision: 3 })).toEqual({ ok: false, error: 'superseded_revision' })
  expect(stateBaseline).not.toHaveBeenCalled()
  for (const state of ['published', 'conflict'] as const) {
    expect(await reorderState(setup({ state }).deps, editor, input)).toEqual({ ok: false, error: 'invalid_state' })
  }
  stateBaseline.mockResolvedValueOnce([])
  expect(await reorderState(deps, editor, { ...input, state: 'XX' })).toEqual({ ok: false, error: 'invalid_state' })
  deps.store.commit = async () => 'revision_mismatch'
  expect(await reorderState(deps, editor, input)).toEqual({ ok: false, error: 'superseded_revision' })
  expect(await store.getBatch('batch')).toEqual(batch)
})

test('detail lists moved plates outside field-edit membership with canonical old and new positions', async () => {
  const { deps } = setup({ stateOrders: { AK: ['AK.three', 'AK.one', 'AK.two'] } })
  const result = await batchDetail(deps, 'batch')
  expect(result).toMatchObject({ ok: true, value: {
    batch: { stateOrders: { AK: ['AK.three', 'AK.one', 'AK.two'] } },
    plates: [
      { baseline: { id: 'AK.one' }, order: { before: 1, after: 1, total: 3 } },
      { baseline: { id: 'AK.three' }, order: { before: 2, after: 0, total: 3 } },
    ],
  } })
})

test('state order arrays are isolated from caller and reader mutations', async () => {
  const order = ['AK.three', 'AK.one', 'AK.two']
  const before = plates.map(plate => plate.id)
  const { store } = setup({ stateOrders: { AK: order }, baselineOrders: { AK: before } })
  before.reverse()
  order.reverse()
  const saved = await store.getBatch('batch')
  expect(saved?.stateOrders.AK).toEqual(['AK.three', 'AK.one', 'AK.two'])
  expect(saved?.baselineOrders?.AK).toEqual(plates.map(plate => plate.id))
  saved?.baselineOrders?.AK.reverse()
  expect((await store.list({}))[0].baselineOrders?.AK).toEqual(plates.map(plate => plate.id))
  saved?.stateOrders.AK.reverse()
  expect((await store.list({}))[0].stateOrders.AK).toEqual(['AK.three', 'AK.one', 'AK.two'])
})

test('a later reorder keeps the first before-order for each state', async () => {
  const { deps, store, stateBaseline } = setup({ baselineOrders: { CA: ['CA.one'] } })
  const firstOrder = ['AK.three', 'AK.two', 'AK.one']
  expect((await reorderState(deps, editor, { batchId: 'batch', state: 'AK', batchRevision: 4, order: firstOrder })).ok).toBe(true)
  stateBaseline.mockResolvedValueOnce([...plates].reverse())
  const secondOrder = ['AK.one', 'AK.three', 'AK.two']
  expect((await reorderState(deps, editor, { batchId: 'batch', state: 'AK', batchRevision: 5, order: secondOrder })).ok).toBe(true)
  expect(await store.getBatch('batch')).toMatchObject({
    stateOrders: { AK: secondOrder }, baselineOrders: { CA: ['CA.one'], AK: plates.map(plate => plate.id) },
  })
})

test('published detail keeps saved positions and versioned fields after the current catalog and curator order change', async () => {
  const { deps, store } = setup()
  const original = plates.find(plate => plate.id === 'AK.one')!
  const fields = { description: 'Updated description' }
  expect((await proposeEdit(deps, editor, { batchId: 'batch', plateId: original.id, baseRevision: plateRevision(original), fields })).ok).toBe(true)
  const order = ['AK.three', 'AK.two', 'AK.one']
  const reordered = await reorderState(deps, editor, { batchId: 'batch', state: 'AK', batchRevision: 5, order })
  if (!reordered.ok) throw new Error('expected reordered batch')
  const current = plates.map(plate => plate.id === original.id ? { ...plate, ...fields } : plate)
  deps.baseline = vi.fn(async id => current.find(plate => plate.id === id) ?? null)
  deps.stateBaseline = vi.fn(async () => order.map(id => current.find(plate => plate.id === id)!))
  deps.baselineAtVersion = vi.fn(async (version, id) => version === 7 ? plates.find(plate => plate.id === id) ?? null : null)
  expect(await store.commit('batch', 6, { batch: { ...reordered.value, state: 'published', revision: 7 } })).toBe('ok')
  const detail = await batchDetail(deps, 'batch')
  if (!detail.ok) throw new Error('expected published detail')
  expect(detail.value.plates.find(plate => plate.baseline.id === original.id)).not.toHaveProperty('order')
  expect(detail).toMatchObject({ ok: true, value: {
    batch: { state: 'published' },
    plates: [
      { baseline: original, proposed: { ...original, ...fields } },
      { baseline: { id: 'AK.three' }, order: { before: 2, after: 0, total: 3 } },
    ],
  } })
  expect(deps.baselineAtVersion).toHaveBeenCalledWith(7, original.id)
  expect(deps.baseline).not.toHaveBeenCalled()
  expect(deps.stateBaseline).not.toHaveBeenCalled()
})

test('field-only detail reads the pinned snapshot after the current catalog changes', async () => {
  const { deps, store } = setup()
  const original = plates.find(plate => plate.id === 'AK.one')!
  const fields = { tags: ['updated'] }
  expect((await proposeEdit(deps, editor, { batchId: 'batch', plateId: original.id, baseRevision: plateRevision(original), fields })).ok).toBe(true)
  deps.baseline = async () => ({ ...original, ...fields })
  const saved = (await store.getBatch('batch'))!
  expect(await store.commit('batch', saved.revision, { batch: { ...saved, state: 'published', revision: saved.revision + 1 } })).toBe('ok')
  expect(await batchDetail(deps, 'batch')).toMatchObject({ ok: true, value: {
    plates: [{ baseline: original, proposed: { ...original, ...fields } }],
  } })
})

test.each(['open', 'published'] as const)('legacy %s detail selects the appropriate before-order', async state => {
  const { deps } = setup({ state, stateOrders: { AK: ['AK.three', 'AK.one', 'AK.two'] } })
  const snapshot = plates.map((plate, index) => ({ ...plate, sortOrder: index }))
  deps.stateBaseline = vi.fn(async (_version, _state, order) => order === 'snapshot' ? snapshot : [...snapshot].reverse())
  const result = await batchDetail(deps, 'batch')
  expect(deps.stateBaseline).toHaveBeenCalledWith(7, 'AK', state === 'published' ? 'snapshot' : undefined)
  expect(result).toMatchObject({ ok: true, value: {
    plates: state === 'published' ? [
      { baseline: { id: 'AK.one' }, order: { before: 1, after: 1, total: 3 } },
      { baseline: { id: 'AK.three' }, order: { before: 2, after: 0, total: 3 } },
    ] : [{ baseline: { id: 'AK.one' } }],
  } })
})

test.each([false, true])('44-plate published detail reports only the move from 22 to 4 with saved before-order: %s', async saved => {
  const snapshot = {
    version: 7,
    plates: Array.from({ length: 44 }, (_, index) => ({
      ...plates[0], id: index === 21 ? 'AK.caribou' : `AK.plate-${index}`, sortOrder: index,
    })).reverse(),
  }
  const before = [...snapshot.plates].reverse().map(plate => plate.id)
  const order = before.filter(id => id !== 'AK.caribou')
  order.splice(3, 0, 'AK.caribou')
  const { deps } = setup({ state: 'published', plateIds: [], stateOrders: { AK: order }, ...(saved ? { baselineOrders: { AK: before } } : {}) })
  deps.stateBaseline = async (_version, state, source) => orderedStatePlates(snapshot, state, {
    stateOrder: source === 'snapshot' ? {} : { AK: order }, stateProgress: {},
  })
  deps.baselineAtVersion = async (version, id) => version === 7 ? snapshot.plates.find(plate => plate.id === id) ?? null : null
  const detail = await batchDetail(deps, 'batch')
  if (!detail.ok) throw new Error('expected published batch detail')
  expect(detail.value.plates).toHaveLength(1)
  expect(detail.value.plates[0].baseline.id).toBe('AK.caribou')
  expect(detail.value.plates[0].order).toEqual({ before: 21, after: 3, total: 44 })
})

test.each([
  { name: 'adjacent swap', order: ['AK.one', 'AK.two', 'AK.three'], moved: [{ id: 'AK.one', before: 1, after: 0 }] },
  { name: 'reverse three', order: ['AK.three', 'AK.one', 'AK.two'], moved: [{ id: 'AK.three', before: 2, after: 0 }, { id: 'AK.one', before: 1, after: 1 }] },
  { name: 'unchanged order', order: ['AK.two', 'AK.one', 'AK.three'], moved: [] },
])('$name reports only plates outside the deterministic increasing subsequence', async ({ order, moved }) => {
  const { deps } = setup({ plateIds: [], stateOrders: { AK: order }, baselineOrders: { AK: plates.map(plate => plate.id) } })
  const detail = await batchDetail(deps, 'batch')
  if (!detail.ok) throw new Error('expected batch detail')
  expect(detail.value.plates.map(plate => ({ id: plate.baseline.id, before: plate.order?.before, after: plate.order?.after }))).toEqual(moved)
  expect(await batchDetail(deps, 'batch')).toEqual(detail)
})
