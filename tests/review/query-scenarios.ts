import { expect, test } from 'vitest'
import type { Plate } from '../../lib/catalog/types'
import { proposeEdit } from '../../lib/review/batch'
import { batchDetail, createBatch, listBatches } from '../../lib/review/queries'
import { plateRevision } from '../../lib/review/revision'
import type {
  ReviewBatch,
  ReviewDeps,
  ReviewStore,
} from '../../lib/review/types'

const editor = {
  uid: 'editor-one',
  name: 'Jane Smith',
  role: 'editor',
} as const
const owner = { uid: 'owner-one', name: null, role: 'owner' } as const
const createdAt = '2026-11-15T12:00:00Z'
const baseline: Plate[] = [
  {
    id: 'one',
    state: 'CA',
    slug: 'one',
    displayName: 'One',
    tags: ['original'],
    image: 'one.png',
    templateRole: 'template',
  },
  {
    id: 'two',
    state: 'CA',
    slug: 'two',
    displayName: 'Two',
    tags: [],
    image: 'two.png',
  },
]
const input = {
  id: 'new-batch',
  name: 'Review plates',
  plateIds: ['two', 'one'],
  baselineVersion: 11,
}

/**
 * Register shared batch listing and detail projection cases for the supplied store
 * backend.
 */
export function reviewQueryScenarios(
  makeStore: () => ReviewStore | Promise<ReviewStore>
) {
  /** Create a controlled catalog and review store for queries against fixture batches. */
  async function setup() {
    const store = await makeStore()
    const deps: ReviewDeps = {
      /** Return fixture baseline plates belonging to the requested state. */
      stateBaseline: async (_version, state) =>
        baseline.filter((plate) => plate.state === state),
      store,
      /** Resolve the plate by ID from the fixture baseline. */
      baselineAtVersion: async (_version, id) =>
        structuredClone(baseline.find((plate) => plate.id === id) ?? null),
      /** Resolve the plate by ID from the fixture baseline. */
      baseline: async (id) =>
        structuredClone(baseline.find((plate) => plate.id === id) ?? null),
      /**
       * Read the test clock used by this operation to calculate timestamps and
       * deadlines.
       */
      now: () => createdAt,
    }
    return { deps, store }
  }

  test.each([editor, owner])(
    'creates an open batch at revision 0: $role',
    async (actor) => {
      const { deps, store } = await setup()
      const expected: ReviewBatch = {
        ...input,
        stateOrders: {},
        state: 'open',
        revision: 0,
        approval: null,
        createdBy: actor.uid,
        createdByName: actor.name,
        createdAt,
      }
      expect(await createBatch(deps, actor, input)).toEqual({
        ok: true,
        value: expected,
      })
      expect(await store.getBatch(input.id)).toEqual(expected)
    }
  )

  test('refuses a duplicate id', async () => {
    const { deps, store } = await setup()
    const first = await createBatch(deps, editor, input)
    expect(
      await createBatch(deps, owner, { ...input, name: 'Replacement' })
    ).toEqual({ ok: false, error: 'invalid_state' })
    expect(first).toEqual({ ok: true, value: await store.getBatch(input.id) })
  })

  test('concurrent creates of one id preserve the winner', async () => {
    const { deps, store } = await setup()
    const results = await Promise.all([
      createBatch(deps, editor, input),
      createBatch(deps, owner, { ...input, name: 'Other' }),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: 'invalid_state' },
    ])
    const winner = results.find((result) => result.ok)
    expect(winner).toEqual({ ok: true, value: await store.getBatch(input.id) })
  })

  test('refuses an empty batch', async () => {
    const { deps, store } = await setup()
    expect(await createBatch(deps, editor, { ...input, plateIds: [] })).toEqual(
      { ok: false, error: 'invalid_state' }
    )
    expect(await store.getBatch(input.id)).toBeNull()
  })

  test.each(['', ' \n\t '])('refuses a blank name: %j', async (name) => {
    const { deps, store } = await setup()
    expect(await createBatch(deps, editor, { ...input, name })).toEqual({
      ok: false,
      error: 'invalid_state',
    })
    expect(await store.getBatch(input.id)).toBeNull()
  })

  test('refuses duplicate plate ids', async () => {
    const { deps, store } = await setup()
    expect(
      await createBatch(deps, editor, { ...input, plateIds: ['one', 'one'] })
    ).toEqual({ ok: false, error: 'invalid_state' })
    expect(await store.getBatch(input.id)).toBeNull()
  })

  test('lists only the requested states, newest first', async () => {
    const { deps, store } = await setup()
    const batches: ReviewBatch[] = [
      {
        ...input,
        stateOrders: {},
        id: 'old',
        state: 'submitted',
        revision: 1,
        approval: null,
        createdBy: editor.uid,
        createdByName: editor.name,
        createdAt: '2026-11-13T12:00:00Z',
      },
      {
        ...input,
        stateOrders: {},
        id: 'approved',
        state: 'approved',
        revision: 2,
        approval: { revision: 1, by: owner.uid, at: createdAt },
        createdBy: editor.uid,
        createdByName: editor.name,
        createdAt,
      },
      {
        ...input,
        stateOrders: {},
        id: 'new',
        state: 'open',
        revision: 0,
        approval: null,
        createdBy: editor.uid,
        createdByName: editor.name,
        createdAt: '2026-11-14T12:00:00Z',
      },
    ]
    for (const batch of batches) expect(await store.create(batch)).toBe('ok')
    expect(await listBatches(deps, { states: ['open', 'submitted'] })).toEqual([
      batches[2],
      batches[0],
    ])
    expect(await store.list({ states: ['open', 'submitted'] })).toEqual([
      batches[2],
      batches[0],
    ])
    expect(await listBatches(deps, {})).toEqual([
      batches[1],
      batches[2],
      batches[0],
    ])
    expect(await listBatches(deps, { states: [] })).toEqual([])
  })

  test('listing by creator composes with state filters', async () => {
    const { deps, store } = await setup()
    await createBatch(deps, editor, input)
    await createBatch(deps, owner, { ...input, id: 'other' })
    expect(await listBatches(deps, { createdBy: editor.uid })).toEqual([
      await store.getBatch(input.id),
    ])
    expect(
      await listBatches(deps, { createdBy: owner.uid, states: ['open'] })
    ).toEqual([await store.getBatch('other')])
    expect(
      await listBatches(deps, { createdBy: editor.uid, states: ['submitted'] })
    ).toEqual([])
    expect(await listBatches(deps, { createdBy: 'missing' })).toEqual([])
    expect(await listBatches(deps, {})).toHaveLength(2)
  })

  test("detail merges edits and returns each plate's revision", async () => {
    const { deps, store } = await setup()
    await createBatch(deps, editor, input)
    const result = await proposeEdit(deps, editor, {
      batchId: input.id,
      plateId: 'one',
      baseRevision: plateRevision(baseline[0]),
      fields: { tags: ['changed'], isStandard: true },
      standard: { from: null, to: 'one' },
    })
    expect(result.ok).toBe(true)
    const proposed = { ...baseline[0], tags: ['changed'], isStandard: true }
    expect(await batchDetail(deps, input.id)).toEqual({
      ok: true,
      value: {
        batch: await store.getBatch(input.id),
        plates: [
          {
            baseline: baseline[1],
            proposed: baseline[1],
            edit: null,
            revision: plateRevision(baseline[1]),
          },
          {
            baseline: baseline[0],
            proposed,
            edit: await store.getEdit(input.id, 'one'),
            revision: plateRevision(proposed),
          },
        ],
      },
    })
    expect(await store.listEdits(input.id)).toEqual([
      await store.getEdit(input.id, 'one'),
    ])
  })

  test('reads a coherent batch and edits through concurrent commits', async () => {
    const { deps, store } = await setup()
    await createBatch(deps, editor, input)
    expect(await store.readBatch('missing')).toBeNull()
    const created = (await store.getBatch(input.id))!
    for (let revision = 1; revision <= 3; revision += 1) {
      const edit = {
        plateId: 'one',
        baseRevision: 'base',
        fields: { tags: [String(revision)] },
        authorId: editor.uid,
        updatedAt: createdAt,
        resultRevision: String(revision),
      }
      const [snapshot] = await Promise.all([
        store.readBatch(input.id),
        store.commit(input.id, revision - 1, {
          batch: { ...created, revision },
          edit,
        }),
      ])
      expect(snapshot).not.toBeNull()
      expect(snapshot!.edits).toEqual(
        snapshot!.batch.revision === 0
          ? []
          : [
              {
                ...edit,
                fields: { tags: [String(snapshot!.batch.revision)] },
                resultRevision: String(snapshot!.batch.revision),
              },
            ]
      )
    }
    const saved = (await store.readBatch(input.id))!
    expect(saved.batch.revision).toBe(3)
    saved.batch.name = 'Outside'
    saved.edits[0].fields.tags!.push('outside')
    expect(await store.readBatch(input.id)).toMatchObject({
      batch: { name: input.name },
      edits: [{ fields: { tags: ['3'] } }],
    })
    const detail = await batchDetail(
      {
        ...deps,
        store: {
          ...store,
          /** Return controlled batch data so the test can exercise the review state. */ getBatch:
            async () => {
              throw new Error('split batch read')
            },
          /** Reject a separate edit read so the test detects loss of the consistent batch snapshot. */ listEdits:
            async () => {
              throw new Error('split edits read')
            },
        },
      },
      input.id
    )
    expect(detail).toMatchObject({
      ok: true,
      value: {
        batch: { revision: 3 },
        plates: [{}, { proposed: { tags: ['3'] } }],
      },
    })
  })

  test('detail revision round-trips into proposeEdit', async () => {
    const { deps } = await setup()
    await createBatch(deps, editor, input)
    await proposeEdit(deps, editor, {
      batchId: input.id,
      plateId: 'one',
      baseRevision: plateRevision(baseline[0]),
      fields: { tags: ['changed'] },
    })
    const detail = await batchDetail(deps, input.id)
    if (!detail.ok) throw new Error('expected batch detail')
    const plate = detail.value.plates[1]
    expect(
      await proposeEdit(deps, editor, {
        batchId: input.id,
        plateId: plate.proposed.id,
        baseRevision: plate.revision,
        fields: { isStandard: true },
        standard: { from: null, to: plate.proposed.id },
      })
    ).toMatchObject({
      ok: true,
      value: {
        batch: { revision: 2 },
        plate: { tags: ['changed'], isStandard: true },
      },
    })
  })

  test('detail refuses a missing batch or baseline plate', async () => {
    const { deps, store } = await setup()
    expect(await batchDetail(deps, input.id)).toEqual({
      ok: false,
      error: 'not_found',
    })
    expect(await store.listEdits(input.id)).toEqual([])
    await createBatch(deps, editor, { ...input, plateIds: ['one', 'missing'] })
    expect(await batchDetail(deps, input.id)).toEqual({
      ok: false,
      error: 'not_found',
    })
  })

  test('created batches and query results cannot mutate stored data', async () => {
    const { deps, store } = await setup()
    const result = await createBatch(deps, editor, {
      ...input,
      plateIds: [...input.plateIds],
    })
    if (!result.ok) throw new Error('expected created batch')
    result.value.plateIds.push('outside')
    const listed = await store.list({})
    listed[0].name = 'Changed outside'
    expect(await store.getBatch(input.id)).toMatchObject({
      name: input.name,
      plateIds: input.plateIds,
    })
    await proposeEdit(deps, editor, {
      batchId: input.id,
      plateId: 'one',
      baseRevision: plateRevision(baseline[0]),
      fields: { tags: ['changed'] },
    })
    const edits = await store.listEdits(input.id)
    edits[0].fields.tags?.push('outside')
    expect(await store.getEdit(input.id, 'one')).toMatchObject({
      fields: { tags: ['changed'] },
    })
  })

  test('saved before-orders survive create, commit, get and list without affecting legacy batches', async () => {
    const { deps, store } = await setup()
    const created = await createBatch(deps, editor, input)
    if (!created.ok) throw new Error('expected created batch')
    expect(await store.getBatch(input.id)).not.toHaveProperty('baselineOrders')
    const baselineOrders = { CA: ['one', 'two'] }
    const next = {
      ...created.value,
      baselineOrders,
      stateOrders: { CA: ['two', 'one'] },
      revision: 1,
    }
    expect(await store.create({ ...next, id: 'saved' })).toBe('ok')
    expect(await store.commit(input.id, 0, { batch: next })).toBe('ok')
    baselineOrders.CA.reverse()
    expect(await store.getBatch(input.id)).toMatchObject({
      baselineOrders: { CA: ['one', 'two'] },
    })
    expect(await store.getBatch('saved')).toMatchObject({
      baselineOrders: { CA: ['one', 'two'] },
    })
    expect((await store.list({})).map((batch) => batch.baselineOrders)).toEqual(
      [{ CA: ['one', 'two'] }, { CA: ['one', 'two'] }]
    )
  })
}
