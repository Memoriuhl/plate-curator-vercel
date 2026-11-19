import { respond } from '../../lib/server/respond'
import { expect, test, vi } from 'vitest'
import { proposeEdit, reorderState } from '../../lib/review/batch'
import { submitBatch } from '../helpers/legacy-approval'
import { editableKeys } from '../../lib/review/fields'
import { copyBatch } from '../../lib/review/copy'
import { createMemoryStore } from '../../lib/review/memory-store'
import { plateRevision } from '../../lib/review/revision'
import type { Plate } from '../../lib/catalog/types'
import type { ReviewBatch, ReviewDeps } from '../../lib/review/types'

const actor = { uid: 'editor', name: null, role: 'editor' } as const
const plates: Plate[] = ['first', 'old', 'third'].map((id) => ({
  id,
  state: 'CA',
  slug: id,
  displayName: id,
  image: '',
  tags: [],
  templateFamily: id,
  templateRole: 'template',
  isStandard: id === 'old',
}))
/** Build ordered state and batch fixtures for standard-plate validation during review. */
function setup() {
  const batch: ReviewBatch = {
    id: 'legacy',
    name: 'Legacy',
    createdBy: actor.uid,
    createdByName: null,
    createdAt: '',
    state: 'open',
    revision: 0,
    baselineVersion: 1,
    stateOrders: { CA: plates.map((plate) => plate.id) },
    plateIds: [],
    approval: null,
  }
  const store = createMemoryStore([batch])
  const deps: ReviewDeps = {
    store,
    /** Use an empty timestamp where the scenario does not depend on dates. */ now: () =>
      '',
    /** Resolve the plate by ID from the fixture baseline. */ baseline: async (
      id
    ) => plates.find((plate) => plate.id === id) ?? null,
    /** Resolve the plate by ID from the fixture baseline. */ baselineAtVersion:
      async (_v, id) => plates.find((plate) => plate.id === id) ?? null,
    /** Return the fixture state order used by the review or queue operation. */ stateBaseline:
      async () => plates,
  }
  return { batch, store, deps }
}
test('legacy mismatches allow unrelated edits and reorders; submit requires an explicit repair', async () => {
  const { deps, store } = setup()
  const tag = await proposeEdit(deps, actor, {
    batchId: 'legacy',
    plateId: 'first',
    baseRevision: plateRevision(plates[0]),
    fields: { tags: ['draft'] },
  })
  expect(tag.ok).toBe(true)
  expect(
    (
      await reorderState(deps, actor, {
        batchId: 'legacy',
        state: 'CA',
        batchRevision: 1,
        order: ['first', 'third', 'old'],
      })
    ).ok
  ).toBe(true)
  expect(await store.listEdits('legacy')).toMatchObject([
    { plateId: 'first', fields: { tags: ['draft'] } },
  ])
  expect(await submitBatch(deps, actor, 'legacy', 2)).toMatchObject({
    error: 'standard_change_unconfirmed',
  })
  const first = { ...plates[0], tags: ['draft'] }
  expect(
    (
      await proposeEdit(deps, actor, {
        batchId: 'legacy',
        plateId: 'first',
        baseRevision: plateRevision(first),
        fields: { isStandard: true },
        standard: { from: 'old', to: 'first' },
      })
    ).ok
  ).toBe(true)
  expect((await submitBatch(deps, actor, 'legacy', 3)).ok).toBe(true)
})
test('rebuilding Standard edits preserves unrelated fields from the shared editable list', async () => {
  const { deps, store } = setup()
  expect(editableKeys).toContain('description')
  for (const plate of plates)
    expect(
      (
        await proposeEdit(deps, actor, {
          batchId: 'legacy',
          plateId: plate.id,
          baseRevision: plateRevision(plate),
          fields: { description: plate.id + ' story' },
        })
      ).ok
    ).toBe(true)
  expect(
    (
      await proposeEdit(deps, actor, {
        batchId: 'legacy',
        plateId: 'first',
        baseRevision: plateRevision({
          ...plates[0],
          description: 'first story',
        }),
        fields: { isStandard: true },
        standard: { from: 'old', to: 'first' },
      })
    ).ok
  ).toBe(true)
  for (const plate of plates)
    expect(await store.getEdit('legacy', plate.id)).toMatchObject({
      fields: { description: plate.id + ' story' },
    })
})
test.each(['first', 'old'])(
  'any effective Standard is a valid acknowledgement: %s',
  async (from) => {
    const { deps, store } = setup()
    deps.stateBaseline = async () =>
      plates.map((plate) => ({ ...plate, isStandard: plate.id !== 'third' }))
    expect(
      (
        await reorderState(deps, actor, {
          batchId: 'legacy',
          state: 'CA',
          batchRevision: 0,
          order: ['third', 'first', 'old'],
          standard: { from, to: 'third' },
        })
      ).ok
    ).toBe(true)
    const edits = await store.listEdits('legacy')
    const effective = (await deps.stateBaseline(1, 'CA')).map((plate) => ({
      ...plate,
      ...edits.find((edit) => edit.plateId === plate.id)?.fields,
    }))
    expect(
      effective.filter((plate) => plate.isStandard).map((plate) => plate.id)
    ).toEqual(['third'])
  }
)
test('copy warns about a new baseline Standard and can be repaired in the copied Batch', async () => {
  const { batch, store, deps } = setup()
  const approved = {
    ...batch,
    baselineVersion: 0,
    state: 'approved' as const,
    plateIds: ['first', 'old'],
    approval: { revision: 0, by: 'owner', at: '' },
  }
  await store.commit(batch.id, 0, {
    batch: approved,
    edits: ['first', 'old'].map((plateId) => ({
      plateId,
      fields: { isStandard: plateId === 'first' },
      baseRevision: '',
      resultRevision: '',
      authorId: actor.uid,
      updatedAt: '',
    })),
  })
  const current = plates.map((plate) => ({
    ...plate,
    isStandard: plate.id === 'third',
  }))
  const result = await copyBatch(
    {
      store,
      env: 'test',
      /** Use an empty timestamp where the scenario does not depend on dates. */ now: () =>
        '',
      /** Expose the current fixture catalog version so the operation can check its baseline. */ head: async () =>
        1,
      /** Supply the catalog or selection snapshot used by the scenario. */ snapshot:
        async () => ({ version: 1, plates: current }),
    },
    { ...actor, role: 'owner' },
    { sourceId: batch.id, sourceRevision: 0, targetVersion: 1 }
  )
  expect(result).toMatchObject({
    ok: true,
    warnings: [expect.stringContaining('CA:')],
  })
  expect(await store.list({})).toHaveLength(2)
  if (!result.ok) throw new Error('Expected copy')
  deps.stateBaseline = async () => current
  deps.baselineAtVersion = async (_version, id) =>
    current.find((plate) => plate.id === id) ?? null
  expect(await submitBatch(deps, actor, result.value.id, 0)).toMatchObject({
    error: 'standard_change_unconfirmed',
    reasons: [expect.stringContaining('CA:')],
  })
  const first = {
    ...current[0],
    ...(await store.getEdit(result.value.id, 'first'))?.fields,
  }
  expect(
    (
      await proposeEdit(deps, actor, {
        batchId: result.value.id,
        plateId: 'first',
        baseRevision: plateRevision(first),
        fields: { isStandard: true },
        standard: { from: 'third', to: 'first' },
      })
    ).ok
  ).toBe(true)
  expect((await submitBatch(deps, actor, result.value.id, 1)).ok).toBe(true)
})

test('failed atomic multi-promotion preserves the original legacy Standard and order', async () => {
  const { deps, store, batch } = setup()
  const variants = ['v', 'w'].map((id) => ({
    ...plates[0],
    id,
    templateRole: 'variant' as const,
    variantOfPlateId: 'first',
    isStandard: false,
  }))
  deps.stateBaseline = async () => [...plates, ...variants]
  const original = {
    ...batch,
    stateOrders: { CA: ['first', 'v', 'w', 'old', 'third'] },
  }
  await store.commit(batch.id, 0, { batch: original })
  deps.store = {
    ...store,
    commit: vi.fn(async () => 'revision_mismatch' as const),
  }
  expect(
    await reorderState(deps, actor, {
      batchId: batch.id,
      state: 'CA',
      batchRevision: 0,
      order: ['v', 'w', 'first', 'old', 'third'],
      promotions: variants.map((plate) => ({
        plateId: plate.id,
        templateFamily: plate.id,
      })),
      standard: { from: 'old', to: 'v' },
    })
  ).toMatchObject({ error: 'superseded_revision' })
  expect(await store.readBatch(batch.id)).toEqual({
    batch: original,
    edits: [],
  })
})

test('compensating a partial move below a legacy first family restores the original Standard without stray edits', async () => {
  const { deps, store, batch } = setup()
  const variant = {
    ...plates[0],
    id: 'v',
    templateRole: 'variant' as const,
    variantOfPlateId: 'first',
    isStandard: false,
  }
  deps.stateBaseline = async () => [plates[0], variant, ...plates.slice(1)]
  deps.baselineAtVersion = async (_v, id) =>
    id === variant.id
      ? variant
      : (plates.find((plate) => plate.id === id) ?? null)
  const originalOrder = ['first', 'v', 'old', 'third']
  await store.commit(batch.id, 0, {
    batch: { ...batch, stateOrders: { CA: originalOrder } },
  })
  expect(
    (
      await reorderState(deps, actor, {
        batchId: batch.id,
        state: 'CA',
        batchRevision: 0,
        order: ['first', 'old', 'third', 'v'],
        promotion: { plateId: 'v', templateFamily: 'new' },
      })
    ).ok
  ).toBe(true)
  expect(
    (await store.listEdits(batch.id)).some((edit) =>
      Object.hasOwn(edit.fields, 'isStandard')
    )
  ).toBe(false)
  expect(
    (
      await reorderState(deps, actor, {
        batchId: batch.id,
        state: 'CA',
        batchRevision: 1,
        order: originalOrder,
      })
    ).ok
  ).toBe(true)
  const current = {
    ...variant,
    ...(await store.getEdit(batch.id, 'v'))?.fields,
  }
  expect(
    (
      await proposeEdit(deps, actor, {
        batchId: batch.id,
        plateId: 'v',
        baseRevision: plateRevision(current),
        fields: {
          templateRole: 'variant',
          templateFamily: 'first',
          variantOfPlateId: 'first',
        },
      })
    ).ok
  ).toBe(true)
  expect(await store.listEdits(batch.id)).toEqual([])
  expect((await store.getBatch(batch.id))?.stateOrders.CA).toEqual(
    originalOrder
  )
  expect(
    (await deps.stateBaseline(1, 'CA'))
      .filter((plate) => plate.isStandard)
      .map((plate) => plate.id)
  ).toEqual(['old'])
})

test('submit returns per-state reasons through the API response', async () => {
  const { batch, store, deps } = setup()
  const ny = plates.map((plate) => ({
    ...plate,
    id: 'NY.' + plate.id,
    state: 'NY',
  }))
  deps.stateBaseline = async (_version, state) => (state === 'NY' ? ny : plates)
  await store.commit(batch.id, 0, {
    batch: {
      ...batch,
      stateOrders: { ...batch.stateOrders, NY: ny.map((plate) => plate.id) },
    },
  })
  const result = await submitBatch(deps, actor, batch.id, 0)
  expect(result).toMatchObject({
    error: 'standard_change_unconfirmed',
    reasons: [expect.stringContaining('CA:'), expect.stringContaining('NY:')],
  })
  const response = respond(result)
  expect(response.status).toBe(409)
  expect((await response.json()).reasons).toEqual([
    expect.stringContaining('CA:'),
    expect.stringContaining('NY:'),
  ])
})
