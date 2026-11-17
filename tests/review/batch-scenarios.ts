import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import type { Plate } from '../../lib/catalog/types'
import { approveBatch, proposeEdit, reorderState, submitBatch } from '../../lib/review/batch'
import { validateTagging } from '../../lib/review/tagging'
import { plateRevision } from '../../lib/review/revision'
import type { ReviewBatch, ReviewDeps, ReviewStore } from '../../lib/review/types'

const editor = { uid: 'editor-one', name: null, role: 'editor' } as const
const owner = { uid: 'owner-one', name: null, role: 'owner' } as const
const baseline: Plate[] = [
  { id: 'one', state: 'CA', slug: 'one', displayName: 'One', tags: ['original'], image: 'one.png', templateRole: 'template' },
  { id: 'two', state: 'CA', slug: 'two', displayName: 'Two', tags: [], image: 'two.png', templateRole: 'template' },
]

export function reviewBatchScenarios(createStore: (batch: ReviewBatch) => ReviewStore | Promise<ReviewStore>, concurrentEditTimeout?: number) {
  async function setup(overrides: Partial<ReviewBatch> = {}) {
    const batch: ReviewBatch = {
      stateOrders: {},
      id: 'batch', name: 'Review plates', createdBy: editor.uid, createdByName: null, createdAt: '2026-11-15T12:00:00Z',
      state: 'open', revision: 4, baselineVersion: 1,
      plateIds: ['one', 'two'], approval: null, ...overrides,
    }
    const store = await createStore(batch)
    const deps: ReviewDeps = {
      stateBaseline: async (_version, state) => baseline.filter(plate => plate.state === state),
      store, baselineAtVersion: async (_version, id) => baseline.find(plate => plate.id === id) ?? null, baseline: async id => baseline.find(plate => plate.id === id) ?? null,
      now: () => '2026-11-15T12:00:00Z',
    }
    const input = { batchId: batch.id, plateId: 'one', baseRevision: plateRevision(baseline[0]), fields: { tags: ['changed'] } }
    return { deps, store, input }
  }

  test.each(['link', 'family'] as const)('new draft families reject deletion and joins in either order: %s', join => {
    return (async () => {
      for (const deletionFirst of [false, true]) {
        const { deps, input } = await setup()
        const promoted = await proposeEdit(deps, editor, { ...input, fields: { templateRole: 'template', templateFamily: 'new-family' } })
        if (!promoted.ok) throw new Error('expected promotion')
        const deletion = { ...input, baseRevision: plateRevision(promoted.value.plate), fields: { deleted: true } }
        const addition = { ...input, plateId: 'two', baseRevision: plateRevision(baseline[1]), fields: { templateRole: 'variant' as const, ...(join === 'link' ? { variantOfPlateId: 'one' } : { templateFamily: 'new-family' }) } }
        if (deletionFirst) {
          expect(await proposeEdit(deps, editor, deletion)).toMatchObject({ ok: true })
          expect(await proposeEdit(deps, editor, addition)).toEqual({ ok: false, error: 'invalid_state' })
        } else {
          expect(await proposeEdit(deps, editor, addition)).toMatchObject({ ok: true })
          expect(await proposeEdit(deps, editor, deletion)).toEqual({ ok: false, error: 'invalid_state' })
        }
      }
    })()
  })

  test('a deleted Variant cannot be promoted by a reorder', async () => {
    const { deps, input, store } = await setup()
    const variant = { ...baseline[0], templateRole: 'variant' as const }
    deps.baselineAtVersion = async () => variant
    expect(await proposeEdit(deps, editor, { ...input, baseRevision: plateRevision(variant), fields: { deleted: true } })).toMatchObject({ ok: true })
    expect(await reorderState(deps, editor, { batchId: input.batchId, state: 'CA', batchRevision: 5, order: ['two', 'one'], promotion: { plateId: 'one', templateFamily: 'new-family' } })).toEqual({ ok: false, error: 'invalid_state' })
    expect(await store.getBatch(input.batchId)).toMatchObject({ revision: 5 })
  })

  test.each(['template', 'variant', undefined] as const)('deletion rejects live explicit links to a parent with role %s', async role => {
    const { deps, input, store } = await setup()
    const parent = { ...baseline[0], templateRole: role }
    const child = { ...baseline[1], templateRole: 'template' as const, variantOfPlateId: parent.id }
    deps.baselineAtVersion = async (_version, id) => id === parent.id ? parent : child
    deps.stateBaseline = async () => [parent, child]
    expect(await proposeEdit(deps, editor, { ...input, baseRevision: plateRevision(parent), fields: { deleted: true } })).toEqual({ ok: false, error: 'invalid_state' })
    expect(await store.getEdit(input.batchId, parent.id)).toBeNull()
    expect(await proposeEdit(deps, editor, { ...input, plateId: child.id, baseRevision: plateRevision(child), fields: { variantOfPlateId: null } })).toMatchObject({ ok: true })
    expect(await proposeEdit(deps, editor, { ...input, baseRevision: plateRevision(parent), fields: { deleted: true } })).toMatchObject({ ok: true })
  })

  test('Template deletion counts role-less family members and ignores their draft deletions', async () => {
    const { deps, input } = await setup()
    const parent = { ...baseline[0], templateRole: 'template' as const, templateFamily: 'family' }
    const child = { ...baseline[1], templateRole: undefined, templateFamily: 'family' }
    deps.baselineAtVersion = async (_version, id) => id === parent.id ? parent : child
    deps.stateBaseline = async () => [parent, child]
    const deletion = { ...input, baseRevision: plateRevision(parent), fields: { deleted: true } }
    expect(await proposeEdit(deps, editor, deletion)).toEqual({ ok: false, error: 'invalid_state' })
    expect(await proposeEdit(deps, editor, { ...input, plateId: child.id, baseRevision: plateRevision(child), fields: { deleted: true } })).toMatchObject({ ok: true })
    expect(await proposeEdit(deps, editor, deletion)).toMatchObject({ ok: true })
  })

  test('Standard plates cannot be deleted or have their Standard flag cleared alone', async () => {
    const { deps, store, input } = await setup()
    const standard = { ...baseline[0], isStandard: true }
    deps.baselineAtVersion = async () => standard
    const proposal = { ...input, baseRevision: plateRevision(standard), fields: { deleted: true } }
    expect(await proposeEdit(deps, editor, proposal)).toEqual({ ok: false, error: 'invalid_state' })
    expect(await store.getEdit('batch', 'one')).toBeNull()
    expect(await proposeEdit(deps, editor, { ...proposal, fields: { isStandard: false } })).toEqual({ ok: false, error: 'standard_required' })
  })

  test.each(['moved', 'promoted', 'deleted'] as const)('Template deletion requires its Variants to be %s in the batch view', async action => {
    const { deps, store, input } = await setup()
    const template: Plate = { ...baseline[0], templateRole: 'template', templateFamily: 'family' }
    const variant: Plate = { ...baseline[1], templateRole: 'variant', templateFamily: 'family', variantOfPlateId: 'one' }
    deps.baselineAtVersion = async (_version, id) => id === 'one' ? template : variant
    deps.stateBaseline = async () => [template, variant]
    const proposal = { ...input, baseRevision: plateRevision(template), fields: { deleted: true } }
    expect(await proposeEdit(deps, editor, proposal)).toEqual({ ok: false, error: 'invalid_state' })
    expect(await store.getBatch('batch')).toMatchObject({ revision: 4 })
    expect(await store.getEdit('batch', 'one')).toBeNull()
    const fields = action === 'moved' ? { templateFamily: 'other', variantOfPlateId: null }
      : action === 'promoted' ? { templateRole: 'template' as const, variantOfPlateId: null } : { deleted: true }
    expect(await proposeEdit(deps, editor, { ...input, plateId: 'two', baseRevision: plateRevision(variant), fields })).toMatchObject({ ok: true })
    expect(await proposeEdit(deps, editor, proposal)).toMatchObject({ ok: true })
  })

  test('undoing a deletion alone removes the proposal and restores its revision', async () => {
    const { deps, store, input } = await setup()
    const deleted = await proposeEdit(deps, editor, { ...input, fields: { deleted: true } })
    if (!deleted.ok) throw new Error('expected deletion')
    const undone = await proposeEdit(deps, editor, { ...input, baseRevision: plateRevision(deleted.value.plate), fields: { deleted: false } })
    expect(await store.getEdit('batch', 'one')).toBeNull()
    if (!undone.ok) throw new Error('expected undo')
    expect(plateRevision(undone.value.plate)).toBe(input.baseRevision)
  })

  test('deletion guards revisions and undo preserves other edits', async () => {
    const { deps, store, input } = await setup()
    const changed = await proposeEdit(deps, editor, input)
    if (!changed.ok) throw new Error('expected edit')
    const deleted = await proposeEdit(deps, editor, { ...input, baseRevision: plateRevision(changed.value.plate), fields: { deleted: true } })
    if (!deleted.ok) throw new Error('expected deletion')
    expect(await proposeEdit(deps, editor, { ...input, fields: { deleted: false } })).toMatchObject({ ok: false, error: 'stale_plate' })
    expect(await store.getEdit('batch', 'one')).toMatchObject({ fields: { deleted: true, tags: ['changed'] } })
    expect(await proposeEdit(deps, editor, { ...input, baseRevision: plateRevision(deleted.value.plate), fields: { deleted: false } })).toMatchObject({ ok: true })
    expect((await store.getEdit('batch', 'one'))?.fields).toEqual({ tags: ['changed'] })
  })

  test('other editors cannot edit or submit a batch', async () => {
    const { deps, store, input } = await setup()
    const other = { ...editor, uid: 'other' }
    expect(await proposeEdit(deps, other, input)).toEqual({ ok: false, error: 'forbidden' })
    expect(await submitBatch(deps, other, 'batch', 4)).toEqual({ ok: false, error: 'forbidden' })
    expect(await store.getBatch('batch')).toMatchObject({ revision: 4 })
  })

  test('editing a catalog plate adds membership in the same revision', async () => {
    const { deps, store, input } = await setup({ plateIds: ['two'] })
    expect(await proposeEdit(deps, editor, input)).toMatchObject({ ok: true, value: { batch: { plateIds: ['two', 'one'], revision: 5 } } })
    expect(await store.getBatch('batch')).toMatchObject({ plateIds: ['two', 'one'], revision: 5 })
    expect(await store.getEdit('batch', 'one')).toMatchObject({ fields: input.fields })
  })

  test('membership additions respect the limit and failed proposals leave membership intact', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `plate-${i}`)
    const { deps, store, input } = await setup({ plateIds: ids })
    expect(await proposeEdit(deps, editor, input)).toEqual({ ok: false, error: 'invalid_state' })
    expect(await proposeEdit(deps, editor, { ...input, plateId: 'missing' })).toEqual({ ok: false, error: 'not_found' })
    expect(await store.getBatch('batch')).toMatchObject({ plateIds: ids, revision: 4 })
    expect(await store.getEdit('batch', 'one')).toBeNull()
  })

  test('the fiftieth member is accepted and existing members remain editable at the limit', async () => {
    const { deps, input } = await setup({ plateIds: Array.from({ length: 49 }, (_, i) => `plate-${i}`) })
    const first = await proposeEdit(deps, editor, input)
    expect(first).toMatchObject({ ok: true, value: { batch: { revision: 5 } } })
    if (!first.ok) throw new Error('expected proposal')
    expect(first.value.batch.plateIds).toHaveLength(50)
    expect(await proposeEdit(deps, editor, { ...input, baseRevision: plateRevision(first.value.plate), fields: { tags: [] } })).toMatchObject({ ok: true })
  })

  test('description edits persist, affect revisions and can be cleared', async () => {
    const { deps, store, input } = await setup()
    const first = await proposeEdit(deps, editor, { ...input, fields: { description: 'A new description' } })
    expect(first).toMatchObject({ ok: true, value: { plate: { description: 'A new description' } } })
    if (!first.ok) throw new Error('expected proposal')
    expect(await store.getEdit('batch', 'one')).toMatchObject({ fields: { description: 'A new description' } })
    expect(plateRevision(first.value.plate)).not.toBe(input.baseRevision)
    expect(await proposeEdit(deps, editor, { ...input, baseRevision: plateRevision(first.value.plate), fields: { description: null } })).toMatchObject({ ok: true, value: { plate: { description: null } } })
    expect(await store.getEdit('batch', 'one')).toMatchObject({ fields: { description: null } })
  })

  test.each([editor, owner])('tagging permits the creator or an owner without batch membership: $role', async actor => {
    const { deps, store } = await setup({ plateIds: ['two'] })
    expect(await validateTagging(deps, actor, 'batch', 'one')).toEqual({ ok: true, value: null })
    expect(await store.getBatch('batch')).toMatchObject({ plateIds: ['two'], revision: 4 })
  })

  test('tagging checks existence, rights, state and catalog baseline in order', async () => {
    const { deps } = await setup({ state: 'submitted' })
    const other = { ...editor, uid: 'other' }
    expect(await validateTagging(deps, other, 'missing', 'missing')).toEqual({ ok: false, error: 'not_found' })
    expect(await validateTagging(deps, other, 'batch', 'missing')).toEqual({ ok: false, error: 'forbidden' })
    expect(await validateTagging(deps, editor, 'batch', 'missing')).toEqual({ ok: false, error: 'invalid_state' })
    const open = await setup()
    expect(await validateTagging(open.deps, editor, 'batch', 'missing')).toEqual({ ok: false, error: 'not_found' })
  })

  test.each(['submitted', 'approved', 'published', 'conflict'] as const)('tagging refuses a %s batch', async state => {
    const { deps } = await setup({ state })
    expect(await validateTagging(deps, editor, 'batch', 'one')).toEqual({ ok: false, error: 'invalid_state' })
  })

  test('accepts an edit made from the current plate revision', async () => {
    const { deps, store, input } = await setup()
    const result = await proposeEdit(deps, editor, input)
    expect(result).toEqual({ ok: true, value: { batch: await store.getBatch('batch'), plate: { ...baseline[0], tags: ['changed'] } } })
    expect(await store.getBatch('batch')).toMatchObject({ revision: 5 })
    expect(await store.getEdit('batch', 'one')).toEqual({
      plateId: 'one', baseRevision: input.baseRevision, fields: input.fields,
      authorId: editor.uid, updatedAt: deps.now(), resultRevision: plateRevision({ ...baseline[0], ...input.fields }),
    })
  })

  test('refuses a stale edit and returns the current plate', async () => {
    const { deps, input } = await setup()
    await proposeEdit(deps, editor, input)
    expect(await proposeEdit(deps, editor, input)).toEqual({ ok: false, error: 'stale_plate', current: { ...baseline[0], tags: ['changed'] } })
  })

  test('editing a submitted batch reopens it', async () => {
    const { deps, input } = await setup({ state: 'submitted' })
    expect(await proposeEdit(deps, editor, input)).toMatchObject({ ok: true, value: { batch: { state: 'open', revision: 5 } } })
  })

  test('editing an approved batch clears the approval', async () => {
    const { deps, input } = await setup({ state: 'approved', approval: { revision: 4, by: owner.uid, at: 'earlier' } })
    expect(await proposeEdit(deps, editor, input)).toMatchObject({ ok: true, value: { batch: { state: 'open', revision: 5, approval: null } } })
  })

  test('an editor cannot approve', async () => {
    const { deps } = await setup({ state: 'submitted' })
    expect(await approveBatch(deps, editor, 'batch', 4)).toEqual({ ok: false, error: 'forbidden' })
  })

  test('approving an older revision fails', async () => {
    const { deps } = await setup({ state: 'submitted' })
    expect(await approveBatch(deps, owner, 'batch', 3)).toEqual({ ok: false, error: 'superseded_revision' })
  })

  test('approving an open batch fails', async () => {
    const { deps } = await setup()
    expect(await approveBatch(deps, owner, 'batch', 4)).toEqual({ ok: false, error: 'invalid_state' })
  })

  test('concurrent edits to different plates both succeed', async () => {
    const { deps, store, input } = await setup()
    let first = true
    deps.store = { ...store, commit: async (...args) => {
      if (first) { first = false; return 'revision_mismatch' }
      return store.commit(...args)
    } }
    const results = await Promise.all([
      proposeEdit(deps, editor, input),
      proposeEdit(deps, owner, { ...input, plateId: 'two', baseRevision: plateRevision(baseline[1]) }),
    ])
    expect(results.every(result => result.ok)).toBe(true)
    expect(await store.getBatch('batch')).toMatchObject({ revision: 6 })
    expect(await store.getEdit('batch', 'one')).toMatchObject({ fields: input.fields })
    expect(await store.getEdit('batch', 'two')).toMatchObject({ fields: input.fields })
  })

  test('an edit equal to the baseline leaves no edit behind', async () => {
    const { deps, store, input } = await setup()
    const first = await proposeEdit(deps, editor, input)
    if (!first.ok) throw new Error('expected first proposal')
    const result = await proposeEdit(deps, editor, { ...input, baseRevision: plateRevision(first.value.plate), fields: { tags: ['original'] } })
    expect(result).toMatchObject({ ok: true, value: { batch: { revision: 6 }, plate: baseline[0] } })
    expect(await store.getEdit('batch', 'one')).toBeNull()
  })

  test.each([editor, owner])('both roles can submit and the owner approves the submitted revision: $role', async actor => {
    const { deps, store } = await setup()
    expect(await submitBatch(deps, actor, 'batch', 4)).toMatchObject({ ok: true, value: { state: 'submitted', revision: 5 } })
    expect(await approveBatch(deps, owner, 'batch', 5)).toMatchObject({ ok: true, value: { state: 'approved', revision: 6, approval: { revision: 5, by: owner.uid, at: deps.now() } } })
    expect(await store.getBatch('batch')).toMatchObject({ state: 'approved' })
  })

  test('partial proposals retain previous fields', async () => {
    const { deps, store, input } = await setup()
    const first = await proposeEdit(deps, editor, input)
    if (!first.ok) throw new Error('expected first proposal')
    const result = await proposeEdit(deps, editor, { ...input, baseRevision: plateRevision(first.value.plate), fields: { isStandard: true }, standard: { from: null, to: 'one' } })
    expect(result).toMatchObject({ ok: true, value: { plate: { tags: ['changed'], isStandard: true } } })
    expect(await store.getEdit('batch', 'one')).toMatchObject({ fields: { tags: ['changed'], isStandard: true } })
  })

  test('three commit mismatches exhaust proposal retries', async () => {
    const { deps, input } = await setup()
    let attempts = 0
    deps.store.commit = async () => { attempts += 1; return 'revision_mismatch' }
    expect(await proposeEdit(deps, editor, input)).toEqual({ ok: false, error: 'superseded_revision' })
    expect(attempts).toBe(3)
  })

  test('concurrent edits to the same plate reject the stale proposal', async () => {
    const { deps, input } = await setup({ id: `batch-pair-${randomUUID()}` })
    const results = await Promise.all([proposeEdit(deps, editor, input), proposeEdit(deps, owner, { ...input, fields: { tags: ['other'] } })])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.find(result => !result.ok)).toMatchObject({ error: 'stale_plate' })
  }, concurrentEditTimeout)

  test.each(['published', 'conflict'] as const)('rejects editing a %s batch', async state => {
    const { deps, input } = await setup({ state })
    expect(await proposeEdit(deps, editor, input)).toEqual({ ok: false, error: 'invalid_state' })
  })

  test('missing batches and plates return not_found', async () => {
    const { deps, input } = await setup()
    expect(await proposeEdit(deps, editor, { ...input, batchId: 'missing' })).toEqual({ ok: false, error: 'not_found' })
    expect(await proposeEdit(deps, editor, { ...input, plateId: 'missing' })).toEqual({ ok: false, error: 'not_found' })
    expect(await submitBatch(deps, editor, 'missing', 4)).toEqual({ ok: false, error: 'not_found' })
    expect(await approveBatch(deps, owner, 'missing', 4)).toEqual({ ok: false, error: 'not_found' })
  })

  test('submitting a superseded revision fails', async () => {
    const { deps } = await setup()
    expect(await submitBatch(deps, editor, 'batch', 3)).toEqual({ ok: false, error: 'superseded_revision' })
  })

  test('store isolates reads and rejects stale commits', async () => {
    const { store } = await setup()
    const batch = await store.getBatch('batch')
    if (!batch) throw new Error('expected batch')
    batch.plateIds.push('outside')
    expect(await store.getBatch('batch')).toMatchObject({ plateIds: ['one', 'two'] })
    expect(await store.commit('batch', 3, { batch })).toBe('revision_mismatch')
    expect(await store.getBatch('batch')).toMatchObject({ revision: 4 })
  })
}
