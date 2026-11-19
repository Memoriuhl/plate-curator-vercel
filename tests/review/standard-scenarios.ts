import { expect, test, vi } from 'vitest'
import { proposeEdit, reorderState } from '../../lib/review/batches/batch'
import { plateRevision } from '../../lib/review/draft/revision'
import type { Plate } from '../../lib/catalog/types'
import type {
  ReviewBatch,
  ReviewDeps,
  ReviewStore,
} from '../../lib/review/types'

const actor = { uid: 'editor', name: null, role: 'editor' } as const
const plates: Plate[] = ['one', 'two', 'three'].map((id, index) => ({
  id,
  state: 'CA',
  slug: id,
  displayName: id,
  image: '',
  tags: [],
  templateRole: 'template',
  templateFamily: id,
  isStandard: index === 0,
}))
/** Register shared standard plate transitions for every supplied review store. */
export function standardScenarios(
  create: (batch: ReviewBatch) => ReviewStore | Promise<ReviewStore>
) {
  /** Create a draft and baseline with a known current standard for ordering tests. */
  async function setup() {
    const batch: ReviewBatch = {
      id: 'standard-batch',
      name: 'Standards',
      createdBy: actor.uid,
      createdByName: null,
      createdAt: '',
      state: 'open',
      revision: 0,
      baselineVersion: 1,
      stateOrders: {},
      plateIds: [],
      approval: null,
    }
    const store = await create(batch)
    const deps: ReviewDeps = {
      store,
      /** Use an empty timestamp where the scenario does not depend on dates. */ now: () =>
        '',
      /** Resolve the plate by ID from the fixture baseline. */ baseline:
        async (id) => plates.find((p) => p.id === id) ?? null,
      /** Resolve the plate by ID from the fixture baseline. */ baselineAtVersion:
        async (_v, id) => plates.find((p) => p.id === id) ?? null,
      /** Return the fixture state order used by the review or queue operation. */ stateBaseline:
        async () => plates,
    }
    return { deps, store }
  }
  test.each([
    undefined,
    { from: null, to: 'two' },
    { from: 'one', to: 'three' },
  ])(
    'rejects missing or mismatched Standard acknowledgement: %j',
    async (standard) => {
      const { deps, store } = await setup()
      const before = await store.readBatch('standard-batch')
      expect(
        await reorderState(deps, actor, {
          batchId: 'standard-batch',
          state: 'CA',
          batchRevision: 0,
          order: ['two', 'one', 'three'],
          standard,
        })
      ).toEqual({ ok: false, error: 'standard_change_unconfirmed' })
      expect(await store.readBatch('standard-batch')).toEqual(before)
    }
  )
  test('order and both Standard flags commit once; reverting order restores flags together', async () => {
    const { deps, store } = await setup()
    const commit = vi.spyOn(store, 'commit')
    expect(
      (
        await reorderState(deps, actor, {
          batchId: 'standard-batch',
          state: 'CA',
          batchRevision: 0,
          order: ['two', 'one', 'three'],
          standard: { from: 'one', to: 'two' },
        })
      ).ok
    ).toBe(true)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(await store.getEdit('standard-batch', 'one')).toMatchObject({
      fields: { isStandard: false },
    })
    expect(await store.getEdit('standard-batch', 'two')).toMatchObject({
      fields: { isStandard: true },
    })
    expect(
      (
        await reorderState(deps, actor, {
          batchId: 'standard-batch',
          state: 'CA',
          batchRevision: 1,
          order: ['one', 'two', 'three'],
          standard: { from: 'two', to: 'one' },
        })
      ).ok
    ).toBe(true)
    expect(await store.listEdits('standard-batch')).toEqual([])
    expect((await store.getBatch('standard-batch'))?.stateOrders.CA).toEqual([
      'one',
      'two',
      'three',
    ])
  })
  test('choosing a Standard moves its family and retains unrelated draft fields', async () => {
    const { deps, store } = await setup()
    const edited = await proposeEdit(deps, actor, {
      batchId: 'standard-batch',
      plateId: 'two',
      baseRevision: plateRevision(plates[1]),
      fields: { tags: ['draft'] },
    })
    if (!edited.ok) throw new Error('expected edit')
    const input = {
      batchId: 'standard-batch',
      plateId: 'two',
      baseRevision: plateRevision(edited.value.plate),
      fields: { isStandard: true },
    }
    expect(await proposeEdit(deps, actor, input)).toMatchObject({
      error: 'standard_change_unconfirmed',
    })
    expect(
      (
        await proposeEdit(deps, actor, {
          ...input,
          standard: { from: 'one', to: 'two' },
        })
      ).ok
    ).toBe(true)
    expect((await store.getBatch('standard-batch'))?.stateOrders.CA).toEqual([
      'two',
      'one',
      'three',
    ])
    expect(await store.getEdit('standard-batch', 'two')).toMatchObject({
      fields: { tags: ['draft'], isStandard: true },
    })
    const current = { ...plates[1], tags: ['draft'], isStandard: true }
    expect(
      await proposeEdit(deps, actor, {
        ...input,
        baseRevision: plateRevision(current),
        fields: { isStandard: false },
      })
    ).toMatchObject({ error: 'standard_required' })
    expect(
      await proposeEdit(deps, actor, {
        ...input,
        baseRevision: plateRevision(current),
        fields: { deleted: true },
      })
    ).toMatchObject({ error: 'invalid_state' })
  })
  test.each(['deleted', 'variant'] as const)(
    'rejects %s first plate without partial writes',
    async (kind) => {
      const { deps, store } = await setup()
      const changed = plates.map((p) =>
        p.id === 'two'
          ? {
              ...p,
              ...(kind === 'deleted'
                ? { deleted: true }
                : { templateRole: 'variant' as const }),
            }
          : p
      )
      deps.stateBaseline = async () => changed
      expect(
        await reorderState(deps, actor, {
          batchId: 'standard-batch',
          state: 'CA',
          batchRevision: 0,
          order: ['two', 'one', 'three'],
          standard: { from: 'one', to: 'two' },
        })
      ).toMatchObject({ error: 'standard_invalid_template' })
      expect(await store.listEdits('standard-batch')).toEqual([])
    }
  )
  test('revision guard rejects all coupled edits together', async () => {
    const { deps, store } = await setup()
    const before = await store.readBatch('standard-batch')
    deps.store = {
      ...store,
      /** Force a revision conflict when the standard transition tries to commit. */ commit:
        async () => 'revision_mismatch',
    }
    expect(
      await reorderState(deps, actor, {
        batchId: 'standard-batch',
        state: 'CA',
        batchRevision: 0,
        order: ['two', 'one', 'three'],
        standard: { from: 'one', to: 'two' },
      })
    ).toMatchObject({ error: 'superseded_revision' })
    expect(await store.readBatch('standard-batch')).toEqual(before)
  })
  test('reordering below the Standard needs no acknowledgement', async () => {
    const { deps } = await setup()
    expect(
      (
        await reorderState(deps, actor, {
          batchId: 'standard-batch',
          state: 'CA',
          batchRevision: 0,
          order: ['one', 'three', 'two'],
        })
      ).ok
    ).toBe(true)
  })
  test('effective draft Standards and deletions are checked before reordering', async () => {
    const { deps, store } = await setup()
    /** Build a stored plate edit with its fixture author and baseline revision. */
    const edit = (
      plateId: string,
      fields: import('../../lib/review/types').EditableFields
    ) => ({
      plateId,
      fields,
      baseRevision: '',
      resultRevision: '',
      authorId: actor.uid,
      updatedAt: '',
    })
    const batch = (await store.getBatch('standard-batch'))!
    await store.commit(batch.id, 0, {
      batch,
      edits: [
        edit('one', { isStandard: false }),
        edit('two', { isStandard: true }),
        edit('three', { deleted: true }),
      ],
    })
    expect(
      await reorderState(deps, actor, {
        batchId: batch.id,
        state: 'CA',
        batchRevision: 0,
        order: ['one', 'two', 'three'],
        standard: { from: 'one', to: 'one' },
      })
    ).toMatchObject({ error: 'standard_change_unconfirmed' })
    expect(
      await reorderState(deps, actor, {
        batchId: batch.id,
        state: 'CA',
        batchRevision: 0,
        order: ['three', 'two', 'one'],
        standard: { from: 'two', to: 'three' },
      })
    ).toMatchObject({ error: 'standard_invalid_template' })
    expect(
      (
        await reorderState(deps, actor, {
          batchId: batch.id,
          state: 'CA',
          batchRevision: 0,
          order: ['one', 'two', 'three'],
          standard: { from: 'two', to: 'one' },
        })
      ).ok
    ).toBe(true)
    expect(await store.getEdit(batch.id, 'two')).toBeNull()
    expect(await store.getEdit(batch.id, 'three')).toMatchObject({
      fields: { deleted: true },
    })
  })
  test('touching a legacy state normalizes duplicate Standards while leaving other states alone', async () => {
    const { deps, store } = await setup()
    deps.stateBaseline = async () =>
      plates.map((plate) => ({ ...plate, isStandard: plate.id !== 'three' }))
    expect(
      (
        await reorderState(deps, actor, {
          batchId: 'standard-batch',
          state: 'CA',
          batchRevision: 0,
          order: ['one', 'two', 'three'],
          standard: { from: 'one', to: 'one' },
        })
      ).ok
    ).toBe(true)
    expect(await store.getEdit('standard-batch', 'two')).toMatchObject({
      fields: { isStandard: false },
    })
    expect((await store.getBatch('standard-batch'))?.stateOrders).toEqual({
      CA: ['one', 'two', 'three'],
    })
  })
  test('a state with no Standard requires an explicit null acknowledgement', async () => {
    const { deps } = await setup()
    deps.stateBaseline = async () =>
      plates.map((plate) => ({ ...plate, isStandard: false }))
    const input = {
      batchId: 'standard-batch',
      state: 'CA',
      batchRevision: 0,
      order: ['two', 'one', 'three'],
    }
    expect(await reorderState(deps, actor, input)).toMatchObject({
      error: 'standard_change_unconfirmed',
    })
    expect(
      (
        await reorderState(deps, actor, {
          ...input,
          standard: { from: null, to: 'two' },
        })
      ).ok
    ).toBe(true)
  })

  test('multiple promotions and a Standard switch commit atomically in one revision', async () => {
    const { deps, store } = await setup()
    const variants = plates.slice(1).map((plate) => ({
      ...plate,
      templateRole: 'variant' as const,
      templateFamily: 'one',
      variantOfPlateId: 'one',
    }))
    deps.stateBaseline = async () => [plates[0], ...variants]
    const commit = vi.spyOn(store, 'commit')
    expect(
      (
        await reorderState(deps, actor, {
          batchId: 'standard-batch',
          state: 'CA',
          batchRevision: 0,
          order: ['two', 'three', 'one'],
          promotions: variants.map((plate) => ({
            plateId: plate.id,
            templateFamily: plate.id,
          })),
          standard: { from: 'one', to: 'two' },
        })
      ).ok
    ).toBe(true)
    expect(commit).toHaveBeenCalledOnce()
    expect(await store.getEdit('standard-batch', 'one')).toMatchObject({
      fields: { isStandard: false },
    })
    expect(await store.getEdit('standard-batch', 'two')).toMatchObject({
      fields: { isStandard: true, templateRole: 'template' },
    })
    expect(await store.getEdit('standard-batch', 'three')).toMatchObject({
      fields: { templateRole: 'template' },
    })
  })
}
