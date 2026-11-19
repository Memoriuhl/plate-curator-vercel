import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import type { Plate } from '../../lib/catalog/types'
import { sharedDraftId } from '../../lib/review/draft/draft-id'
import {
  migrateToSharedDraft,
  type MigrationOptions,
} from '../../lib/review/migration/migrate'
import { plateRevision } from '../../lib/review/draft/revision'
import type {
  BatchState,
  ProposedEdit,
  ReviewBatch,
  ReviewDeps,
  ReviewStore,
} from '../../lib/review/types'

const LIVE = 9
const OLD = 8
/** A plate fixture with no tags. */
const plate = (id: string, extra: Partial<Plate> = {}): Plate => ({
  id,
  state: id.split('.')[0],
  slug: id,
  displayName: id,
  image: `${id}.png`,
  tags: [],
  ...extra,
})
const live: Plate[] = [
  plate('AK.one'),
  plate('AK.two'),
  plate('AK.three', { tags: ['published'] }),
  plate('AL.one'),
  plate('AL.two'),
]
// Catalog v8 had older tags on AK.three and a plate that has since been removed.
const old: Plate[] = [
  ...live.map((entry) =>
    entry.id === 'AK.three' ? { ...entry, tags: ['old'] } : entry
  ),
  plate('AK.gone'),
]
const liveOrder = (state: string) =>
  live.filter((entry) => entry.state === state).map((entry) => entry.id)
/** A save time on 2026-11-17, `hour` hours after midnight UTC. */
const at = (hour: number) =>
  `2026-11-17T${String(hour).padStart(2, '0')}:00:00.000Z`
const actor = { uid: 'migration', name: 'Shared draft migration' }

/** Wire review deps to the two-version catalog fixture. */
function deps(store: ReviewStore): ReviewDeps {
  const find = async (version: number, id: string) =>
    (version === LIVE ? live : old).find((entry) => entry.id === id) ?? null
  return {
    store,
    baseline: (id) => find(LIVE, id),
    baselineAtVersion: find,
    stateBaseline: async (version, state) =>
      (version === LIVE ? live : old).filter((entry) => entry.state === state),
    liveVersion: async () => LIVE,
    now: () => '2026-11-18T12:00:00.000Z',
  }
}

/** A legacy Batch edit; the migration recomputes its revisions. */
function edit(
  plateId: string,
  fields: ProposedEdit['fields'],
  updatedAt: string,
  authorId: string,
  extra: Partial<ProposedEdit> = {}
): ProposedEdit {
  return {
    plateId,
    fields,
    authorId,
    updatedAt,
    baseRevision: 'legacy-base',
    resultRevision: 'legacy-result',
    ...extra,
  }
}

/** Expected draft edit fields on the live plate, with fresh revisions. */
function onLive(plateId: string, fields: ProposedEdit['fields']) {
  const base = live.find((entry) => entry.id === plateId)!
  return {
    plateId,
    fields,
    baseRevision: plateRevision(base),
    resultRevision: plateRevision({ ...base, ...fields }),
  }
}

/**
 * Register the one-time Batch-to-shared-draft migration scenarios against a store
 * factory. Each call gets its own environment so drafts and Batches never collide.
 */
export function migrationScenarios(
  makeStore: (env: string) => Promise<ReviewStore> | ReviewStore,
  timeout?: number
) {
  /** Seed one environment with legacy Batches and an optional shared draft. */
  async function seeded(
    batches: { batch: ReviewBatch; edits: ProposedEdit[] }[],
    draft?: { batch: Partial<ReviewBatch>; edits: ProposedEdit[] }
  ) {
    const run = randomUUID().slice(0, 8)
    const env = `migrate-${run}`
    const store = await makeStore(env)
    const id = (name: string) => `${run}-${name}`
    const draftId = sharedDraftId(env)
    for (const { batch, edits } of batches)
      expect(await store.create({ ...batch, id: id(batch.id) }, edits)).toBe(
        'ok'
      )
    if (draft)
      expect(
        await store.create(
          {
            id: draftId,
            kind: 'shared-draft',
            name: 'Shared draft',
            createdBy: 'system',
            createdByName: null,
            createdAt: at(0),
            lastChangedAt: at(0),
            state: 'open',
            revision: 5,
            baselineVersion: LIVE,
            approval: null,
            stateOrders: {},
            baselineOrders: {},
            plateIds: draft.edits.map((entry) => entry.plateId),
            rebaseFloor: 0,
            ...draft.batch,
          },
          draft.edits.map((entry) => ({ ...entry, revision: 5 }))
        )
      ).toBe('ok')
    const migrate = (options: Partial<MigrationOptions> = {}) =>
      migrateToSharedDraft(deps(store), env, {
        apply: true,
        actor,
        ...options,
      })
    return { store, env, id, draftId, migrate }
  }

  /** A legacy Batch made by one curator. */
  function legacy(
    name: string,
    state: BatchState,
    creator: string,
    createdAt: string,
    extra: Partial<ReviewBatch> = {}
  ): ReviewBatch {
    return {
      id: name,
      name: `${creator}'s Batch`,
      createdBy: creator.toLowerCase(),
      createdByName: creator,
      createdAt,
      lastChangedAt: createdAt,
      state,
      revision: 3,
      baselineVersion: LIVE,
      approval: null,
      plateIds: [],
      stateOrders: {},
      ...extra,
    }
  }

  /** Three conflicting Batches, a conflicted and a published one, and a draft. */
  function conflicting() {
    return seeded(
      [
        {
          batch: legacy('ana', 'open', 'Ana', at(1), {
            stateOrders: { AK: ['AK.two', 'AK.one', 'AK.three'] },
            baselineOrders: { AK: liveOrder('AK') },
            stateOrderChangedAt: { AK: at(3) },
          }),
          edits: [
            edit(
              'AK.one',
              { tags: ['ana'], description: 'from ana' },
              at(2),
              'ana'
            ),
            edit('AK.two', { description: 'ana text' }, at(4), 'ana'),
            edit('AL.one', { tags: ['ana-al'] }, at(1), 'ana'),
          ],
        },
        {
          batch: legacy('ben', 'submitted', 'Ben', at(2), {
            stateOrders: {
              AK: ['AK.three', 'AK.one', 'AK.two'],
              AL: ['AL.two', 'AL.one'],
            },
            baselineOrders: { AK: liveOrder('AK'), AL: liveOrder('AL') },
            stateOrderChangedAt: { AK: at(1), AL: at(2) },
          }),
          edits: [
            edit('AK.one', { tags: ['ben'] }, at(4), 'ben'),
            // Saved at 02:00, but the pipeline wrote the description at 05:00.
            edit('AK.two', { description: 'pipeline text' }, at(2), 'ben', {
              pipelineChanges: {
                description: {
                  runId: 'run-1',
                  jobId: 'job-1',
                  by: 'pipeline',
                  byName: 'Plate Pipeline',
                  at: at(5),
                  value: 'pipeline text',
                },
              },
              pipelineRunIds: ['run-1'],
            }),
            // Put back to the live value after the draft changed it.
            edit('AL.two', { tags: [] }, at(5), 'ben'),
          ],
        },
        {
          // Started on Catalog v8; AK.three's tags were published since.
          batch: legacy('cy', 'approved', 'Cy', at(3), {
            baselineVersion: OLD,
            approval: { revision: 3, by: 'owner', at: at(7) },
          }),
          edits: [
            edit('AK.three', { tags: ['cy'] }, at(6), 'cy'),
            edit('AK.two', { tags: ['cy-two'] }, at(6), 'cy'),
            edit('AK.gone', { tags: ['gone'] }, at(6), 'cy'),
          ],
        },
        {
          batch: legacy('dan', 'conflict', 'Dan', at(4)),
          edits: [edit('AK.one', { tags: ['dan'] }, at(9), 'dan')],
        },
        {
          batch: legacy('eve', 'published', 'Eve', at(5)),
          edits: [edit('AK.one', { tags: ['eve'] }, at(9), 'eve')],
        },
      ],
      {
        batch: {},
        edits: [
          edit('AL.one', { tags: ['draft-al'] }, at(3), 'dee', {
            authorName: 'Dee',
          }),
          edit('AL.two', { tags: ['draft-two'] }, at(1), 'dee', {
            authorName: 'Dee',
          }),
        ],
      }
    )
  }

  test(
    'conflicting Batches fold into the draft with the newest value per field and per state order',
    async () => {
      const { store, id, draftId, migrate } = await conflicting()
      const report = await migrate()
      expect(report).toMatchObject({
        applied: true,
        draftId,
        folded: [id('ana'), id('ben'), id('cy')],
        skipped: [{ id: id('dan'), state: 'conflict' }],
        removed: ['AL.two'],
        orders: { AK: id('ana'), AL: id('ben') },
      })
      expect(report.plates).toEqual([
        {
          plateId: 'AK.one',
          fields: { tags: id('ben'), description: id('ana') },
        },
        {
          plateId: 'AK.two',
          fields: { description: id('ben'), tags: id('cy') },
        },
      ])
      expect(report.conflicts).toEqual(
        expect.arrayContaining([
          {
            plateId: 'AK.one',
            field: 'tags',
            winner: id('ben'),
            losers: [id('ana')],
          },
          {
            plateId: 'AK.two',
            field: 'description',
            winner: id('ben'),
            losers: [id('ana')],
          },
          {
            plateId: 'AL.two',
            field: 'tags',
            winner: id('ben'),
            losers: [draftId],
          },
          { state: 'AK', winner: id('ana'), losers: [id('ben')] },
        ])
      )
      expect(report.kept).toEqual([
        { batchId: id('cy'), plateId: 'AK.three', field: 'tags' },
      ])
      expect(report.warnings).toEqual([
        `Plate no longer in the catalog: AK.gone (from ${id('cy')})`,
      ])

      const draft = (await store.readBatch(draftId))!
      expect(draft.batch).toMatchObject({
        revision: 6,
        rebaseFloor: 6,
        baselineVersion: LIVE,
        migratedBatchIds: [id('ana'), id('ben'), id('cy')],
        stateOrders: {
          AK: ['AK.two', 'AK.one', 'AK.three'],
          AL: ['AL.two', 'AL.one'],
        },
        baselineOrders: { AK: liveOrder('AK'), AL: liveOrder('AL') },
        stateOrderChangedAt: { AK: at(3), AL: at(2) },
      })
      expect([...draft.batch.plateIds].sort()).toEqual([
        'AK.one',
        'AK.two',
        'AL.one',
      ])
      const edits = Object.fromEntries(
        draft.edits.map((entry) => [entry.plateId, entry])
      )
      expect(Object.keys(edits).sort()).toEqual(['AK.one', 'AK.two', 'AL.one'])
      expect(edits['AK.one']).toMatchObject({
        ...onLive('AK.one', { tags: ['ben'], description: 'from ana' }),
        authorId: 'ben',
        authorName: 'Ben',
        updatedAt: at(4),
      })
      expect(edits['AK.two']).toMatchObject({
        ...onLive('AK.two', {
          description: 'pipeline text',
          tags: ['cy-two'],
        }),
        authorId: 'cy',
        authorName: 'Cy',
        pipelineRunIds: ['run-1'],
        pipelineChanges: { description: { runId: 'run-1', at: at(5) } },
      })
      expect(edits['AL.one']).toMatchObject({
        fields: { tags: ['draft-al'] },
        authorId: 'dee',
      })

      for (const name of ['ana', 'ben', 'cy'])
        expect(await store.getBatch(id(name))).toMatchObject({
          state: 'folded',
          foldedInto: draftId,
          revision: 4,
        })
      // Folded and published Batches stay readable as history.
      expect(await store.listEdits(id('ana'))).toHaveLength(3)
      expect(await store.getBatch(id('dan'))).toMatchObject({
        state: 'conflict',
        revision: 3,
      })
      expect(await store.getBatch(id('eve'))).toMatchObject({
        state: 'published',
        revision: 3,
      })
      expect(await store.listEdits(id('eve'))).toHaveLength(1)
    },
    timeout
  )

  test(
    'a dry run reports the plan and writes nothing',
    async () => {
      const { store, id, draftId, migrate } = await conflicting()
      const report = await migrate({ apply: false })
      expect(report).toMatchObject({
        applied: false,
        folded: [id('ana'), id('ben'), id('cy')],
        removed: ['AL.two'],
        orders: { AK: id('ana'), AL: id('ben') },
      })
      expect(await store.getBatch(draftId)).toMatchObject({ revision: 5 })
      expect(await store.listEdits(draftId)).toHaveLength(2)
      expect(await store.getBatch(id('ana'))).toMatchObject({
        state: 'open',
        revision: 3,
      })
    },
    timeout
  )

  test(
    'a second run finds nothing to fold and leaves the draft alone',
    async () => {
      const { store, draftId, migrate } = await conflicting()
      await migrate()
      const after = await store.readBatch(draftId)
      const again = await migrate()
      expect(again).toMatchObject({
        applied: true,
        folded: [],
        plates: [],
        removed: [],
      })
      expect(again).toHaveProperty('orders', {})
      expect(await store.readBatch(draftId)).toEqual(after)
    },
    timeout
  )

  test(
    'a run stopped after marking Batches folded finishes them next time',
    async () => {
      const { store, id, draftId, migrate } = await seeded([
        {
          batch: legacy('ana', 'open', 'Ana', at(1)),
          edits: [edit('AK.one', { tags: ['ana'] }, at(2), 'ana')],
        },
      ])
      const batch = (await store.getBatch(id('ana')))!
      expect(
        await store.commit(batch.id, batch.revision, {
          batch: {
            ...batch,
            state: 'folded',
            foldedInto: draftId,
            revision: batch.revision + 1,
          },
          history: false,
        })
      ).toBe('ok')
      const report = await migrate()
      expect(report.folded).toEqual([id('ana')])
      const draft = (await store.readBatch(draftId))!
      expect(draft.batch.migratedBatchIds).toEqual([id('ana')])
      expect(draft.edits).toMatchObject([
        { plateId: 'AK.one', fields: { tags: ['ana'] } },
      ])
    },
    timeout
  )

  test(
    'dry run, apply and a run stopped after folding pick the same order for mixed legacy timestamps',
    async () => {
      const ana = ['AK.two', 'AK.one', 'AK.three']
      const ben = ['AK.three', 'AK.one', 'AK.two']
      // Ana's order is timed only by her Batch's last save; Ben's by its own stamp.
      const mixed = () =>
        seeded([
          {
            batch: legacy('ana', 'open', 'Ana', at(1), {
              lastChangedAt: at(10),
              stateOrders: { AK: ana },
              baselineOrders: { AK: liveOrder('AK') },
            }),
            edits: [],
          },
          {
            batch: legacy('ben', 'open', 'Ben', at(2), {
              lastChangedAt: at(11),
              stateOrders: { AK: ben },
              baselineOrders: { AK: liveOrder('AK') },
              stateOrderChangedAt: { AK: at(11) },
            }),
            edits: [],
          },
        ])

      const dry = await mixed()
      expect((await dry.migrate({ apply: false })).orders).toEqual({
        AK: dry.id('ben'),
      })

      const applied = await mixed()
      expect((await applied.migrate()).orders).toEqual({
        AK: applied.id('ben'),
      })
      expect(
        (await applied.store.getBatch(applied.draftId))!.stateOrders
      ).toEqual({ AK: ben })
      // Folding closes the Batch but keeps its own last-save time.
      expect(await applied.store.getBatch(applied.id('ana'))).toMatchObject({
        state: 'folded',
        lastChangedAt: at(10),
      })

      const stopped = await mixed()
      // The first run closes both Batches, then stops before the draft write.
      const stopping = new Proxy(stopped.store, {
        get(target, key, receiver) {
          if (key !== 'commit') return Reflect.get(target, key, receiver)
          return (
            id: string,
            ...rest: Parameters<ReviewStore['commit']> extends [
              string,
              ...infer R,
            ]
              ? R
              : never
          ) => {
            if (id === stopped.draftId)
              throw new Error('stopped before the draft write')
            return target.commit(id, ...rest)
          }
        },
      })
      await expect(
        migrateToSharedDraft(deps(stopping), stopped.env, {
          apply: true,
          actor,
        })
      ).rejects.toThrow('stopped')
      expect(await stopped.store.getBatch(stopped.id('ana'))).toMatchObject({
        state: 'folded',
      })
      expect((await stopped.migrate()).orders).toEqual({
        AK: stopped.id('ben'),
      })
      expect(
        (await stopped.store.getBatch(stopped.draftId))!.stateOrders
      ).toEqual({ AK: ben })
    },
    timeout
  )

  test(
    'a tie between a Batch and the draft keeps the draft value',
    async () => {
      const { store, draftId, migrate } = await seeded(
        [
          {
            batch: legacy('ana', 'open', 'Ana', at(1), {
              stateOrders: { AK: ['AK.three', 'AK.two', 'AK.one'] },
              baselineOrders: { AK: liveOrder('AK') },
              stateOrderChangedAt: { AK: at(5) },
            }),
            edits: [edit('AK.one', { tags: ['ana'] }, at(5), 'ana')],
          },
        ],
        {
          batch: {
            stateOrders: { AK: ['AK.two', 'AK.one', 'AK.three'] },
            baselineOrders: { AK: liveOrder('AK') },
            stateOrderChangedAt: { AK: at(5) },
          },
          edits: [edit('AK.one', { tags: ['draft'] }, at(5), 'dee')],
        }
      )
      await migrate()
      const draft = (await store.readBatch(draftId))!
      expect(draft.edits).toMatchObject([
        { plateId: 'AK.one', fields: { tags: ['draft'] } },
      ])
      expect(draft.batch.stateOrders.AK).toEqual([
        'AK.two',
        'AK.one',
        'AK.three',
      ])
    },
    timeout
  )

  test(
    'a Batch order saved against an order that has since been published keeps the live order',
    async () => {
      const { store, id, draftId, migrate } = await seeded([
        {
          batch: legacy('ana', 'open', 'Ana', at(1), {
            stateOrders: { AK: ['AK.three', 'AK.two', 'AK.one'] },
            // Live order was different when Ana started; another order shipped since.
            baselineOrders: { AK: ['AK.two', 'AK.one', 'AK.three'] },
            stateOrderChangedAt: { AK: at(8) },
          }),
          edits: [],
        },
      ])
      const report = await migrate()
      expect(report.kept).toEqual([{ batchId: id('ana'), state: 'AK' }])
      expect(report.orders).toEqual({})
      expect((await store.getBatch(draftId))!.stateOrders).toEqual({})
    },
    timeout
  )

  test.each(['pipeline_busy', 'publish_locked', 'migration_running'] as const)(
    'the migration refuses to write while %s',
    async (reason) => {
      const { store, id, draftId, migrate } = await conflicting()
      const report = await migrate({
        fence: {
          acquire: async () => reason,
          confirm: async () => null,
          held: () => ({ token: 'test', catalogVersion: null }),
          release: async () => {},
        },
      })
      expect(report).toMatchObject({ applied: false, refused: reason })
      expect(await store.getBatch(draftId)).toMatchObject({ revision: 5 })
      expect(await store.getBatch(id('ana'))).toMatchObject({ state: 'open' })
    },
    timeout
  )
}
