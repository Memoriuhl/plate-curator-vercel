import { expect, test } from 'vitest'
import type { Plate } from '../../lib/catalog/types'
import { approveBatch, proposeEdit, submitBatch } from '../../lib/review/batch'
import { createMemoryStore } from '../../lib/review/memory-store'
import { plateRevision } from '../../lib/review/revision'
import type { ReviewBatch, ReviewDeps } from '../../lib/review/types'

const editor = { uid: 'editor-one', role: 'editor' } as const
const owner = { uid: 'owner-one', role: 'owner' } as const
const baseline: Plate[] = [
  { id: 'one', state: 'CA', slug: 'one', displayName: 'One', tags: ['original'], image: 'one.png' },
  { id: 'two', state: 'CA', slug: 'two', displayName: 'Two', tags: [], image: 'two.png' },
]

function setup(overrides: Partial<ReviewBatch> = {}) {
  const batch: ReviewBatch = {
    id: 'batch', state: 'open', revision: 4, baselineVersion: 1,
    plateIds: ['one', 'two'], approval: null, ...overrides,
  }
  const store = createMemoryStore([batch])
  const deps: ReviewDeps = {
    store, baseline: async id => baseline.find(plate => plate.id === id) ?? null,
    now: () => '2026-11-15T12:00:00Z',
  }
  const input = { batchId: 'batch', plateId: 'one', baseRevision: plateRevision(baseline[0]), fields: { tags: ['changed'] } }
  return { deps, store, input }
}

test('accepts an edit made from the current plate revision', async () => {
  const { deps, store, input } = setup()
  const result = await proposeEdit(deps, editor, input)
  expect(result).toEqual({ ok: true, value: { batch: await store.getBatch('batch'), plate: { ...baseline[0], tags: ['changed'] } } })
  expect(await store.getBatch('batch')).toMatchObject({ revision: 5 })
  expect(await store.getEdit('batch', 'one')).toEqual({
    plateId: 'one', baseRevision: input.baseRevision, fields: input.fields,
    authorId: editor.uid, updatedAt: deps.now(), resultRevision: plateRevision({ ...baseline[0], ...input.fields }),
  })
})

test('refuses a stale edit and returns the current plate', async () => {
  const { deps, input } = setup()
  await proposeEdit(deps, editor, input)
  expect(await proposeEdit(deps, editor, input)).toEqual({ ok: false, error: 'stale_plate', current: { ...baseline[0], tags: ['changed'] } })
})

test('editing a submitted batch reopens it', async () => {
  const { deps, input } = setup({ state: 'submitted' })
  expect(await proposeEdit(deps, editor, input)).toMatchObject({ ok: true, value: { batch: { state: 'open', revision: 5 } } })
})

test('editing an approved batch clears the approval', async () => {
  const { deps, input } = setup({ state: 'approved', approval: { revision: 4, by: owner.uid, at: 'earlier' } })
  expect(await proposeEdit(deps, editor, input)).toMatchObject({ ok: true, value: { batch: { state: 'open', revision: 5, approval: null } } })
})

test('an editor cannot approve', async () => {
  const { deps } = setup({ state: 'submitted' })
  expect(await approveBatch(deps, editor, 'batch', 4)).toEqual({ ok: false, error: 'forbidden' })
})

test('approving an older revision fails', async () => {
  const { deps } = setup({ state: 'submitted' })
  expect(await approveBatch(deps, owner, 'batch', 3)).toEqual({ ok: false, error: 'superseded_revision' })
})

test('approving an open batch fails', async () => {
  const { deps } = setup()
  expect(await approveBatch(deps, owner, 'batch', 4)).toEqual({ ok: false, error: 'invalid_state' })
})

test('concurrent edits to different plates both succeed', async () => {
  const { deps, store, input } = setup()
  let first = true
  deps.store = { ...store, commit: async (...args) => {
    if (first) { first = false; return 'revision_mismatch' }
    return store.commit(...args)
  } }
  const results = await Promise.all([
    proposeEdit(deps, editor, input),
    proposeEdit(deps, { ...editor, uid: 'editor-two' }, { ...input, plateId: 'two', baseRevision: plateRevision(baseline[1]) }),
  ])
  expect(results.every(result => result.ok)).toBe(true)
  expect(await store.getBatch('batch')).toMatchObject({ revision: 6 })
  expect(await store.getEdit('batch', 'one')).toMatchObject({ fields: input.fields })
  expect(await store.getEdit('batch', 'two')).toMatchObject({ fields: input.fields })
})

test('an edit equal to the baseline leaves no edit behind', async () => {
  const { deps, store, input } = setup()
  const first = await proposeEdit(deps, editor, input)
  if (!first.ok) throw new Error('expected first proposal')
  const result = await proposeEdit(deps, editor, { ...input, baseRevision: plateRevision(first.value.plate), fields: { tags: ['original'] } })
  expect(result).toMatchObject({ ok: true, value: { batch: { revision: 6 }, plate: baseline[0] } })
  expect(await store.getEdit('batch', 'one')).toBeNull()
})

test.each([editor, owner])('both roles can submit and the owner approves the submitted revision: $role', async actor => {
  const { deps, store } = setup()
  expect(await submitBatch(deps, actor, 'batch', 4)).toMatchObject({ ok: true, value: { state: 'submitted', revision: 5 } })
  expect(await approveBatch(deps, owner, 'batch', 5)).toMatchObject({ ok: true, value: { state: 'approved', revision: 6, approval: { revision: 5, by: owner.uid, at: deps.now() } } })
  expect(await store.getBatch('batch')).toMatchObject({ state: 'approved' })
})

test('partial proposals retain previous fields', async () => {
  const { deps, store, input } = setup()
  const first = await proposeEdit(deps, editor, input)
  if (!first.ok) throw new Error('expected first proposal')
  const result = await proposeEdit(deps, editor, { ...input, baseRevision: plateRevision(first.value.plate), fields: { isStandard: true } })
  expect(result).toMatchObject({ ok: true, value: { plate: { tags: ['changed'], isStandard: true } } })
  expect(await store.getEdit('batch', 'one')).toMatchObject({ fields: { tags: ['changed'], isStandard: true } })
})

test('three commit mismatches exhaust proposal retries', async () => {
  const { deps, input } = setup()
  let attempts = 0
  deps.store.commit = async () => { attempts += 1; return 'revision_mismatch' }
  expect(await proposeEdit(deps, editor, input)).toEqual({ ok: false, error: 'superseded_revision' })
  expect(attempts).toBe(3)
})

test('concurrent edits to the same plate reject the stale proposal', async () => {
  const { deps, input } = setup()
  const results = await Promise.all([proposeEdit(deps, editor, input), proposeEdit(deps, owner, { ...input, fields: { tags: ['other'] } })])
  expect(results.filter(result => result.ok)).toHaveLength(1)
  expect(results.find(result => !result.ok)).toMatchObject({ error: 'stale_plate' })
})

test.each(['published', 'conflict'] as const)('rejects editing a %s batch', async state => {
  const { deps, input } = setup({ state })
  expect(await proposeEdit(deps, editor, input)).toEqual({ ok: false, error: 'invalid_state' })
})

test('missing batches and plates return not_found', async () => {
  const { deps, input } = setup()
  expect(await proposeEdit(deps, editor, { ...input, batchId: 'missing' })).toEqual({ ok: false, error: 'not_found' })
  expect(await proposeEdit(deps, editor, { ...input, plateId: 'missing' })).toEqual({ ok: false, error: 'not_found' })
  expect(await submitBatch(deps, editor, 'missing', 4)).toEqual({ ok: false, error: 'not_found' })
  expect(await approveBatch(deps, owner, 'missing', 4)).toEqual({ ok: false, error: 'not_found' })
})

test('submitting a superseded revision fails', async () => {
  const { deps } = setup()
  expect(await submitBatch(deps, editor, 'batch', 3)).toEqual({ ok: false, error: 'superseded_revision' })
})

test('memory store isolates reads and rejects stale commits', async () => {
  const { store } = setup()
  const batch = await store.getBatch('batch')
  if (!batch) throw new Error('expected batch')
  batch.plateIds.push('outside')
  expect(await store.getBatch('batch')).toMatchObject({ plateIds: ['one', 'two'] })
  expect(await store.commit('batch', 3, { batch })).toBe('revision_mismatch')
  expect(await store.getBatch('batch')).toMatchObject({ revision: 4 })
})
