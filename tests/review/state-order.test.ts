import { expect, test, vi } from 'vitest'
import { reorderState } from '../../lib/review/batch'
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
  const deps: ReviewDeps = { store, stateBaseline, baseline: async id => plates.find(plate => plate.id === id) ?? null, now: () => '' }
  return { deps, store, stateBaseline }
}

test('reordering saves the full state from the pinned version without expanding field-edit membership', async () => {
  const { deps, store, stateBaseline } = setup()
  const order = ['AK.three', 'AK.two', 'AK.one']
  expect(await reorderState(deps, editor, { batchId: 'batch', state: 'AK', batchRevision: 4, order })).toEqual({
    ok: true, value: { ...batch, revision: 5, stateOrders: { AK: order } },
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
      { baseline: { id: 'AK.two' }, order: { before: 0, after: 2, total: 3 } },
      { baseline: { id: 'AK.three' }, order: { before: 2, after: 0, total: 3 } },
    ],
  } })
})

test('state order arrays are isolated from caller and reader mutations', async () => {
  const order = ['AK.three', 'AK.one', 'AK.two']
  const { store } = setup({ stateOrders: { AK: order } })
  order.reverse()
  const saved = await store.getBatch('batch')
  expect(saved?.stateOrders.AK).toEqual(['AK.three', 'AK.one', 'AK.two'])
  saved?.stateOrders.AK.reverse()
  expect((await store.list({}))[0].stateOrders.AK).toEqual(['AK.three', 'AK.one', 'AK.two'])
})
