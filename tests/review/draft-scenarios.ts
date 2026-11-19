import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import type { Plate } from '../../lib/catalog/types'
import { orderedStatePlates } from '../../lib/catalog/order'
import { applyReleaseEdits } from '../../lib/publish/apply-edits'
import { validateSnapshot } from '../../lib/publish/validation'
import { proposeEdit, reorderState } from '../../lib/review/batch'
import { discardPlateChanges } from '../../lib/review/discard-changes'
import { revertPipelineRun } from '../../lib/review/revert-run'
import {
  afterPublish,
  draftAtRevision,
  ensureDraft,
  freezeRelease,
  keepDraftValues,
} from '../../lib/review/draft'
import { sharedDraftId } from '../../lib/review/draft-id'
import { draftCommitAttempts } from '../../lib/review/retry'
import { plateRevision } from '../../lib/review/revision'
import type {
  Actor,
  EditableFields,
  ProposedEdit,
  ReviewDeps,
  ReviewStore,
  VersionOrigin,
} from '../../lib/review/types'

const owner: Actor = { uid: 'owner', name: 'Owner', role: 'owner' }
/** A curator with their own uid. */
const editor = (uid: string): Actor => ({ uid, name: uid, role: 'editor' })
/** A plate fixture with no tags at a catalog position. */
const plate = (id: string, sortOrder: number): Plate => ({
  id,
  state: id.split('.')[0],
  slug: id,
  displayName: id,
  image: `${id}.png`,
  tags: [],
  sortOrder,
})
const v1 = [
  ...['one', 'two', 'three', 'four', 'five', 'six'].map((n, i) =>
    plate(`AK.${n}`, i)
  ),
  ...['one', 'two', 'three'].map((n, i) => plate(`AL.${n}`, i)),
]

/**
 * Register shared draft scenarios (concurrent writers, publishing one revision while
 * curators keep editing, and change-log pruning) against a store factory.
 */
export function sharedDraftScenarios(
  makeStore: (env: string) => Promise<ReviewStore> | ReviewStore,
  timeout?: number
) {
  /** A fresh environment whose catalog can move to new versions. */
  async function setup(plates = v1) {
    const env = `draft-${randomUUID().slice(0, 8)}`
    const store = await makeStore(env)
    const versions = new Map<number, Plate[]>([[1, plates]])
    // Committed publish receipts by the version they moved the pointer to.
    const origins = new Map<number, VersionOrigin>()
    // The curator order Publish projects after each commit. Like production, it is not
    // versioned: it always holds the latest projection, whatever version is asked for.
    const curatorOrder: Record<string, string[]> = {}
    let live = 1
    const d: ReviewDeps = {
      store,
      baseline: async (id) =>
        versions.get(live)!.find((entry) => entry.id === id) ?? null,
      baselineAtVersion: async (version, id) =>
        versions.get(version)?.find((entry) => entry.id === id) ?? null,
      snapshotAtVersion: async (version) => ({
        version,
        plates: versions.get(version)!,
      }),
      stateBaseline: async (version, state, order) =>
        orderedStatePlates(
          { version, plates: versions.get(version) ?? [] },
          state,
          {
            stateOrder: order === 'snapshot' ? {} : curatorOrder,
            stateProgress: {},
          }
        ),
      liveVersion: async () => live,
      versionOrigin: async (version) => origins.get(version) ?? null,
      now: () => new Date().toISOString(),
    }
    const draftId = sharedDraftId(env)
    /** Save fields on one plate from the draft's current value. */
    const save = async (actor: Actor, id: string, fields: EditableFields) => {
      const draft = (await store.getBatch(draftId))!
      const base = (await d.baselineAtVersion(draft.baselineVersion, id))!
      const current = {
        ...base,
        ...(await store.getEdit(draftId, id))?.fields,
      }
      return proposeEdit(d, actor, {
        batchId: draftId,
        plateId: id,
        baseRevision: plateRevision(current),
        fields,
      })
    }
    /** Save tags on one plate from the draft's current value. */
    const tag = (actor: Actor, id: string, tags: string[]) =>
      save(actor, id, { tags })
    /**
     * Commit a release the way Publish does: the pointer moves to a new version built and
     * validated as Publish builds it, and the receipt records who asked and when.
     * The receipt stays unsettled until `settle`, as it is while the state order
     * projection is still being written.
     */
    const commit = async (
      releaseId: string,
      by: { uid: string; email: string } = { uid: 'owner', email: 'owner@x' }
    ) => {
      const release = (await store.readBatch(releaseId))!
      const next = Math.max(...versions.keys()) + 1
      const { deleted, plates } = applyReleaseEdits(
        versions.get(live)!,
        release.edits,
        release.batch.stateOrders
      )
      const reasons = validateSnapshot(
        { version: live, plates: versions.get(live)! },
        { version: next, plates },
        deleted
      )
      if (reasons.length) throw new Error(reasons.join('; '))
      versions.set(next, plates)
      Object.assign(curatorOrder, release.batch.stateOrders)
      origins.set(next, {
        batchId: releaseId,
        revision: release.batch.revision,
        fromVersion: live,
        toVersion: next,
        by: by.uid,
        byName: by.email,
        at: `2026-11-18T12:00:0${next}.000Z`,
        settled: false,
      })
      live = next
      return next
    }
    /**
     * Commit a publish from outside this draft (an old Batch) that ships state orders,
     * with its receipt unsettled like `commit`.
     */
    const publishElsewhere = (stateOrders: Record<string, string[]>) => {
      const next = Math.max(...versions.keys()) + 1
      versions.set(
        next,
        applyReleaseEdits(versions.get(live)!, [], stateOrders).plates
      )
      Object.assign(curatorOrder, stateOrders)
      origins.set(next, {
        batchId: `elsewhere-${next}`,
        revision: 1,
        fromVersion: live,
        toVersion: next,
        by: 'ben',
        byName: 'ben@x',
        at: `2026-11-18T12:00:0${next}.000Z`,
        settled: false,
      })
      live = next
      return next
    }
    /** Point live back at an existing version outside any publish, as a repair would. */
    const repoint = (version: number) => {
      live = version
    }
    /** Finish the publish that moved the pointer to this version. */
    const settle = (version: number) => {
      origins.set(version, { ...origins.get(version)!, settled: true })
    }
    /** Publish a release start to finish, then run the post-publish draft step. */
    const publish = async (releaseId: string) => {
      const next = await commit(releaseId)
      settle(next)
      return afterPublish(d, releaseId, next)
    }
    /**
     * Move the pointer outside any release of this draft, changing some plates; null
     * removes a plate.
     */
    const outsideChange = (changes: Record<string, Partial<Plate> | null>) => {
      const next = Math.max(...versions.keys()) + 1
      versions.set(
        next,
        versions
          .get(live)!
          .filter((entry) => changes[entry.id] !== null)
          .map((entry) => ({ ...entry, ...changes[entry.id] }))
      )
      live = next
      return next
    }
    return {
      env,
      store,
      d,
      draftId,
      save,
      tag,
      publish,
      commit,
      settle,
      outsideChange,
      publishElsewhere,
      repoint,
    }
  }

  /** Fields by plate id, for comparing draft contents. */
  const fieldsOf = (edits: ProposedEdit[]) =>
    Object.fromEntries(
      [...edits]
        .sort((left, right) => left.plateId.localeCompare(right.plateId))
        .map((entry) => [entry.plateId, entry.fields])
    )

  test(
    'curators and pipeline results saving different plates at once all land on the one draft document',
    async () => {
      const { store, d, draftId, env, tag } = await setup()
      const draft = await ensureDraft(d, env, owner)
      const plates = ['one', 'two', 'three', 'four', 'five', 'six']
      // One fewer writer than the retry budget: every failed attempt means another
      // writer committed, so each writer is guaranteed a turn.
      expect(plates.length + 1).toBeLessThanOrEqual(draftCommitAttempts)
      const results = await Promise.all([
        ...plates.map((n) => tag(editor(`curator-${n}`), `AK.${n}`, [n])),
        reorderState(d, owner, {
          batchId: draftId,
          state: 'AL',
          batchRevision: draft.revision,
          order: ['AL.one', 'AL.three', 'AL.two'],
        }),
      ])
      expect(results.filter((result) => !result.ok)).toEqual([])
      const head = (await store.readBatch(draftId))!
      expect(head.batch.revision).toBe(draft.revision + 7)
      expect(fieldsOf(head.edits)).toEqual(
        Object.fromEntries(plates.map((n) => [`AK.${n}`, { tags: [n] }]))
      )
      expect(head.batch.stateOrders).toEqual({
        AL: ['AL.one', 'AL.three', 'AL.two'],
      })
    },
    timeout
  )

  test(
    'publishing revision N ships N; edits after N stay in the draft and the published change log is pruned',
    async () => {
      const { store, d, draftId, env, tag, publish } = await setup()
      await ensureDraft(d, env, owner)
      await tag(editor('ana'), 'AK.one', ['one']) // revision 1
      await tag(editor('ben'), 'AK.two', ['two']) // revision 2
      expect(
        await reorderState(d, owner, {
          batchId: draftId,
          state: 'AL',
          batchRevision: 2,
          order: ['AL.one', 'AL.three', 'AL.two'],
        })
      ).toMatchObject({ ok: true }) // revision 3
      await tag(editor('cy'), 'AK.three', ['three']) // revision 4

      const frozen = await freezeRelease(d, env, owner, 2)
      if (!frozen.ok) throw new Error(frozen.error)
      const release = (await store.readBatch(frozen.value.id))!
      expect(fieldsOf(release.edits)).toEqual({
        'AK.one': { tags: ['one'] },
        'AK.two': { tags: ['two'] },
      })
      expect(release.batch.stateOrders).toEqual({})

      // While revision 2 publishes, curators keep going.
      await tag(editor('ana'), 'AK.one', ['one-later']) // revision 5
      await tag(editor('ben'), 'AK.two', []) // revision 6: put back to v1

      const rebased = await publish(frozen.value.id)
      expect(rebased).toMatchObject({ ok: true, changed: true })
      const head = (await store.readBatch(draftId))!
      expect(head.batch).toMatchObject({
        baselineVersion: 2,
        revision: 7,
        rebaseFloor: 7,
        lastPublish: { releaseId: frozen.value.id, revision: 2, version: 2 },
        stateOrders: { AL: ['AL.one', 'AL.three', 'AL.two'] },
      })
      // AK.one's later value and AK.three stay; AK.two's put-back undoes the published
      // value, so the draft now carries the old value forward.
      expect(fieldsOf(head.edits)).toEqual({
        'AK.one': { tags: ['one-later'] },
        'AK.three': { tags: ['three'] },
        'AK.two': { tags: [] },
      })
      for (const entry of head.edits)
        expect(entry.baseRevision).toBe(
          plateRevision((await d.baselineAtVersion(2, entry.plateId))!)
        )
      // History for the published revisions is gone; the unpublished changes keep
      // their before-images for revert.
      const changes = await store.listChanges!(draftId, 0)
      expect(changes.map((change) => change.revision)).toEqual([3, 4, 5, 6])
      expect(changes.every((change) => change.before)).toBe(true)
      expect(draftAtRevision(head, changes, 4)).toEqual({
        ok: false,
        reason: 'below_floor',
      })

      // Publishing again is idempotent and the next release ships the later edits.
      expect(await afterPublish(d, frozen.value.id, 2)).toMatchObject({
        ok: true,
        changed: false,
      })
      const next = await freezeRelease(d, env, owner, 7)
      if (!next.ok) throw new Error(next.error)
      const shipped = (await store.readBatch(next.value.id))!
      expect(Object.keys(fieldsOf(shipped.edits))).toEqual([
        'AK.one',
        'AK.three',
        'AK.two',
      ])
      expect(shipped.batch.stateOrders).toEqual({
        AL: ['AL.one', 'AL.three', 'AL.two'],
      })
    },
    timeout
  )

  test(
    'an earlier revision rebuilds from the change log while later saves continue',
    async () => {
      const { store, d, draftId, env, tag } = await setup()
      await ensureDraft(d, env, owner)
      await tag(editor('ana'), 'AK.one', ['first'])
      await tag(editor('ana'), 'AK.one', ['second'])
      await tag(editor('ben'), 'AK.two', ['two'])
      const head = (await store.readBatch(draftId))!
      const changes = await store.listChanges!(draftId, 0)
      const at1 = draftAtRevision(head, changes, 1)
      expect(at1.ok && fieldsOf(at1.edits)).toEqual({
        'AK.one': { tags: ['first'] },
      })
      expect(draftAtRevision(head, changes, 4)).toEqual({
        ok: false,
        reason: 'ahead',
      })
    },
    timeout
  )

  test(
    'the draft is created once, even when two requests ask for it together',
    async () => {
      const { store, d, draftId, env } = await setup()
      const [left, right] = await Promise.all([
        ensureDraft(d, env, owner),
        ensureDraft(d, env, editor('ana')),
      ])
      expect(left.id).toBe(draftId)
      expect(right.id).toBe(draftId)
      expect(await store.getBatch(draftId)).toMatchObject({
        kind: 'shared-draft',
        revision: 0,
        baselineVersion: 1,
      })
    },
    timeout
  )

  test(
    'a read while Publish is still finishing waits, then keeps a reset made after the published revision',
    async () => {
      const { store, d, draftId, env, tag, commit, settle } = await setup()
      await ensureDraft(d, env, owner)
      await tag(editor('ana'), 'AK.one', ['Reviewed']) // revision 1
      const frozen = await freezeRelease(d, env, owner, 1)
      if (!frozen.ok) throw new Error(frozen.error)
      // Revision 2 puts the tags back, so the draft no longer stores a change.
      await tag(editor('ben'), 'AK.one', []) // revision 2
      expect((await store.readBatch(draftId))!.edits).toEqual([])

      const version = await commit(frozen.value.id)
      // A Dashboard read lands after the pointer moved, before Publish finished.
      expect(await ensureDraft(d, env, editor('cy'))).toMatchObject({
        baselineVersion: 1,
        revision: 2,
      })

      settle(version)
      // The release itself is not marked published yet; its receipt names it.
      expect((await store.getBatch(frozen.value.id))!.state).toBe('open')
      expect(await ensureDraft(d, env, editor('cy'))).toMatchObject({
        baselineVersion: 2,
        lastPublish: { releaseId: frozen.value.id, revision: 1, version: 2 },
      })
      expect(fieldsOf((await store.readBatch(draftId))!.edits)).toEqual({
        'AK.one': { tags: [] },
      })
      expect(await afterPublish(d, frozen.value.id, version)).toMatchObject({
        ok: true,
        changed: false,
      })
    },
    timeout
  )

  test(
    "an older release's delayed post-publish step leaves a draft a later release already moved on",
    async () => {
      const { store, d, draftId, env, tag, commit, settle, publish } =
        await setup()
      await ensureDraft(d, env, owner)
      await tag(editor('ana'), 'AK.one', ['First']) // revision 1
      const first = await freezeRelease(d, env, owner, 1)
      if (!first.ok) throw new Error(first.error)
      const v2 = await commit(first.value.id)
      settle(v2)
      // The first release's post-publish step stalls; a read moves the draft instead.
      await ensureDraft(d, env, editor('ben'))
      await tag(editor('ben'), 'AK.one', ['Second'])
      const draft = (await store.getBatch(draftId))!
      const second = await freezeRelease(d, env, owner, draft.revision)
      if (!second.ok) throw new Error(second.error)
      await publish(second.value.id)

      // The stalled step finally runs.
      expect(await afterPublish(d, first.value.id, v2)).toMatchObject({
        ok: true,
        changed: false,
      })
      const head = (await store.readBatch(draftId))!
      expect(head.batch).toMatchObject({
        baselineVersion: 3,
        lastPublish: { releaseId: second.value.id },
      })
      expect(head.edits).toEqual([])
      await ensureDraft(d, env, editor('cy'))
      expect((await store.readBatch(draftId))!.edits).toEqual([])
    },
    timeout
  )

  test(
    'reverting the source link keeps the draft image, other fields and other plates',
    async () => {
      const { d, env, draftId, store, save } = await setup()
      const draft = await ensureDraft(d, env, owner)
      const tags = ['Hand checked']
      await save(owner, 'AK.two', { tags })
      const edit = (await store.getEdit(draftId, 'AK.two'))!
      const imageUrl = 'https://example.com/image.jpg'
      expect(
        await store.commit(draftId, 1, {
          batch: { ...draft, revision: 2, plateIds: ['AK.two'] },
          edit: {
            ...edit,
            fields: { tags, imageUrl, sourceUrl: 'https://example.com/source' },
          },
        })
      ).toBe('ok')
      await save(owner, 'AK.three', { tags })
      const other = await store.getEdit(draftId, 'AK.three')
      expect(
        await discardPlateChanges(d, editor('ana'), {
          batchId: draftId,
          plateId: 'AK.two',
          batchRevision: 2,
          target: 'sourceUrl',
        })
      ).toMatchObject({ ok: true })
      expect((await store.getEdit(draftId, 'AK.two'))?.fields).toEqual({
        tags,
        imageUrl,
      })
      expect(await store.getEdit(draftId, 'AK.three')).toEqual(other)
    },
    timeout
  )

  test(
    'reverting a position moves only that plate in the current state order',
    async () => {
      const plates = v1.map((p) =>
        p.id === 'AK.one'
          ? { ...p, isStandard: true, templateRole: 'template' as const }
          : p
      )
      const { d, draftId, env, store, save } = await setup(plates)
      await ensureDraft(d, env, owner)
      const baseline = plates.filter((p) => p.state === 'AK').map((p) => p.id)
      const order = [
        'AK.one',
        'AK.three',
        'AK.five',
        'AK.two',
        'AK.four',
        'AK.six',
      ]
      await save(owner, 'AK.two', { tags: ['Keep'] })
      const draft = (await store.getBatch(draftId))!
      expect(
        await store.commit(draftId, 1, {
          batch: {
            ...draft,
            revision: 2,
            stateOrders: { AK: order },
            baselineOrders: { AK: baseline },
          },
        })
      ).toBe('ok')
      const edit = await store.getEdit(draftId, 'AK.two')
      expect(
        await discardPlateChanges(d, editor('ana'), {
          batchId: draftId,
          plateId: 'AK.two',
          batchRevision: 2,
          target: 'order',
        })
      ).toMatchObject({
        ok: true,
        value: {
          stateOrders: {
            AK: [
              'AK.one',
              'AK.two',
              'AK.three',
              'AK.five',
              'AK.four',
              'AK.six',
            ],
          },
          stateOrderChangedAt: { AK: expect.any(String) },
        },
      })
      expect(await store.getEdit(draftId, 'AK.two')).toEqual(edit)
      expect((await store.listChanges!(draftId, 2))[0]).toMatchObject({
        orderStates: ['AK'],
        before: { stateOrders: { AK: order }, edits: {} },
      })
    },
    timeout
  )

  test(
    'reverting a Standard field refuses to clear its companion plate or move its position',
    async () => {
      const plates = v1.map((p) => ({
        ...p,
        templateRole: 'template' as const,
        isStandard: p.id === 'AK.one',
      }))
      const { d, draftId, env, store, save } = await setup(plates)
      await ensureDraft(d, env, owner)
      expect(await save(owner, 'AK.two', { isStandard: true })).toMatchObject({
        ok: false,
      })
      const head = (await store.getBatch(draftId))!
      const base = plates.find((p) => p.id === 'AK.two')!
      expect(
        await proposeEdit(d, owner, {
          batchId: draftId,
          plateId: base.id,
          baseRevision: plateRevision(base),
          fields: { isStandard: true },
          standard: { from: 'AK.one', to: base.id },
        })
      ).toMatchObject({ ok: true })
      const before = await store.readBatch(draftId)
      expect(
        await discardPlateChanges(d, editor('ana'), {
          batchId: draftId,
          plateId: 'AK.two',
          batchRevision: head.revision + 1,
          target: 'isStandard',
        })
      ).toMatchObject({
        ok: false,
        error: 'invalid_state',
        reasons: [expect.stringContaining('Standard')],
      })
      expect(await store.readBatch(draftId)).toEqual(before)
    },
    timeout
  )

  test(
    'a run revert restores prior values in one revision and lists a field overwritten by another curator',
    async () => {
      const { d, draftId, env, store, save } = await setup()
      await ensureDraft(d, env, owner)
      await save(owner, 'AK.two', { tags: ['Before'] })
      const draft = (await store.getBatch(draftId))!
      const runId = 'run-example'
      const at = d.now()
      const edits = await Promise.all(
        ['AK.two', 'AK.three'].map(async (plateId) => {
          const base = (await d.baselineAtVersion(1, plateId))!
          const pipeline = {
            runId,
            jobId: `job-${plateId}`,
            by: owner.uid,
            byName: owner.name,
            at,
          }
          const fields = {
            tags: ['Pipeline'],
            description: 'Pipeline description',
          }
          return {
            plateId,
            fields,
            baseRevision: plateRevision(base),
            resultRevision: plateRevision({ ...base, ...fields }),
            authorId: owner.uid,
            authorName: owner.name,
            updatedAt: at,
            pipelineRunIds: [runId],
            pipelineChanges: {
              tags: {
                ...pipeline,
                previous: plateId === 'AK.two' ? ['Before'] : [],
                value: fields.tags,
              },
              description: { ...pipeline, value: fields.description },
            },
          }
        })
      )
      expect(
        await store.commit(draftId, 1, {
          batch: {
            ...draft,
            revision: 2,
            plateIds: edits.map((edit) => edit.plateId),
          },
          edits,
        })
      ).toBe('ok')
      await save(editor('ana'), 'AK.three', {
        description: 'Human description',
      })
      // A precondition check must also preserve another edit that lands after planning.
      const commit = store.commit
      let racing = true
      const concurrent = {
        ...d,
        store: {
          ...store,
          async commit(...args: Parameters<ReviewStore['commit']>) {
            if (racing) {
              racing = false
              expect(
                await save(editor('ana'), 'AK.two', { colorDetail: 'blue' })
              ).toMatchObject({ ok: true })
            }
            return commit(...args)
          },
        },
      }
      expect(
        await revertPipelineRun(concurrent, editor('ben'), {
          batchId: draftId,
          runId,
        })
      ).toMatchObject({
        ok: true,
        value: {
          revision: 5,
          reverted: 3,
          skipped: [{ plateId: 'AK.three', field: 'description' }],
        },
      })
      expect(fieldsOf((await store.readBatch(draftId))!.edits)).toEqual({
        'AK.two': { tags: ['Before'], colorDetail: 'blue' },
        'AK.three': { description: 'Human description' },
      })
    },
    timeout
  )

  test(
    'a field the published revision added and a later revision discarded is cleared on the next Publish',
    async () => {
      const { store, d, draftId, env, save, publish } = await setup()
      await ensureDraft(d, env, owner)
      await save(editor('ana'), 'AK.one', { description: 'Added' }) // revision 1
      const frozen = await freezeRelease(d, env, owner, 1)
      if (!frozen.ok) throw new Error(frozen.error)
      expect(
        await discardPlateChanges(d, editor('ana'), {
          batchId: draftId,
          plateId: 'AK.one',
          batchRevision: 1,
          target: 'description',
        })
      ).toMatchObject({ ok: true }) // revision 2
      const rebased = await publish(frozen.value.id)
      expect(rebased).toMatchObject({ ok: true, warnings: [] })
      expect(fieldsOf((await store.readBatch(draftId))!.edits)).toEqual({
        'AK.one': { description: null },
      })
    },
    timeout
  )

  test(
    'an outside change after a committed release still replays that release and keeps a reset made after it',
    async () => {
      const { store, d, draftId, env, tag, commit, settle, outsideChange } =
        await setup()
      await ensureDraft(d, env, owner)
      await tag(editor('ana'), 'AK.one', ['Reviewed']) // revision 1
      const frozen = await freezeRelease(d, env, owner, 1)
      if (!frozen.ok) throw new Error(frozen.error)
      await tag(editor('ben'), 'AK.one', []) // revision 2: put back
      const version = await commit(frozen.value.id)
      // Before Publish finishes, an outside update touches a different plate.
      outsideChange({ 'AK.two': { tags: ['live'] } })

      // The release is still finishing, so the draft waits rather than skip it.
      expect(await ensureDraft(d, env, editor('cy'))).toMatchObject({
        baselineVersion: 1,
      })
      settle(version)
      const settled = await ensureDraft(d, env, editor('cy'))
      expect(settled).toMatchObject({
        baselineVersion: 3,
        lastPublish: { releaseId: frozen.value.id, version: 2 },
      })
      expect(settled.conflicts).toBeUndefined()
      expect(fieldsOf((await store.readBatch(draftId))!.edits)).toEqual({
        'AK.one': { tags: [] },
      })
    },
    timeout
  )

  test(
    'publishes the receipts cannot put in order leave the draft for the Owner to review before Publish',
    async () => {
      const setupResult = await setup()
      const { store, d, draftId, env, tag, commit, settle } = setupResult
      const { publishElsewhere, outsideChange, repoint } = setupResult
      await ensureDraft(d, env, owner)
      await tag(editor('ana'), 'AK.one', ['Reviewed']) // revision 1
      const frozen = await freezeRelease(d, env, owner, 1)
      if (!frozen.ok) throw new Error(frozen.error)
      settle(await commit(frozen.value.id)) // v2 from v1
      // A repair puts the pointer back on v1, an old Batch publishes from there, and an
      // outside update follows, all before the draft settles.
      repoint(1)
      settle(publishElsewhere({})) // v3 from v1
      outsideChange({ 'AK.two': { tags: ['live'] } }) // v4

      // The draft stays on its baseline with its edits until the Owner reviews it.
      const draft = await ensureDraft(d, env, editor('cy'))
      expect(draft).toMatchObject({ baselineVersion: 1, rebaseFloor: 0 })
      expect(draft.conflicts).toEqual([
        { kind: 'catalog', fromVersion: 1, toVersion: 4 },
      ])
      expect(await freezeRelease(d, env, owner, draft.revision)).toEqual({
        ok: false,
        error: 'draft_conflicts',
      })
      // A curator's save does not clear it; the Owner's review does.
      await tag(editor('ana'), 'AK.three', ['three'])
      const edited = (await store.getBatch(draftId))!
      expect(edited.conflicts).toHaveLength(1)
      expect(
        await keepDraftValues(d, owner, {
          batchId: draftId,
          revision: edited.revision,
        })
      ).toMatchObject({ ok: true })
      const kept = (await store.readBatch(draftId))!
      expect(kept.batch).toMatchObject({ baselineVersion: 4 })
      expect(kept.batch.conflicts).toBeUndefined()
      expect(fieldsOf(kept.edits)).toEqual({
        'AK.one': { tags: ['Reviewed'] },
        'AK.three': { tags: ['three'] },
      })
    },
    timeout
  )

  test(
    'a put-back made after a publishing revision waits for the Owner when the receipts cannot trace the span',
    async () => {
      const { store, d, draftId, env, tag, commit, settle, outsideChange } =
        await setup()
      await ensureDraft(d, env, owner)
      await tag(editor('ana'), 'AK.one', ['shipped']) // revision 1
      expect(
        await reorderState(d, owner, {
          batchId: draftId,
          state: 'AL',
          batchRevision: 1,
          order: ['AL.one', 'AL.three', 'AL.two'],
        })
      ).toMatchObject({ ok: true }) // revision 2
      const frozen = await freezeRelease(d, env, owner, 2)
      if (!frozen.ok) throw new Error(frozen.error)
      // The Publish command is accepted.
      await store.commit(frozen.value.id, 0, {
        batch: {
          ...frozen.value,
          state: 'approved',
          revision: 1,
          approval: { revision: 0, by: owner.uid, at: d.now() },
        },
      })
      await tag(editor('ben'), 'AK.one', []) // revision 3: put back
      expect(
        await discardPlateChanges(d, editor('ben'), {
          batchId: draftId,
          plateId: 'AL.three',
          batchRevision: 3,
          target: 'order',
        })
      ).toMatchObject({ ok: true }) // revision 4: order put back
      await tag(editor('cy'), 'AK.three', ['three']) // revision 5
      settle(await commit(frozen.value.id)) // v2
      // More outside updates than a rebase traces, all to a different plate.
      for (let step = 0; step < 21; step += 1)
        outsideChange({ 'AK.two': { tags: [`live${step}`] } }) // v3 to v23

      const held = await ensureDraft(d, env, owner)
      expect(held).toMatchObject({ baselineVersion: 1, rebaseFloor: 0 })
      expect(held.conflicts).toEqual([
        {
          kind: 'catalog',
          fromVersion: 1,
          toVersion: 23,
          resets: [{ plateId: 'AK.one', fields: { tags: [] } }],
          orderResets: { AL: ['AL.one', 'AL.two', 'AL.three'] },
        },
      ])
      expect(fieldsOf((await store.readBatch(draftId))!.edits)).toEqual({
        'AK.three': { tags: ['three'] },
      })
      expect(await freezeRelease(d, env, owner, held.revision)).toEqual({
        ok: false,
        error: 'draft_conflicts',
      })
      // A curator's save keeps the decision waiting for the Owner.
      await tag(editor('ana'), 'AK.four', ['four'])
      const edited = await ensureDraft(d, env, editor('ana'))
      expect(edited.conflicts).toEqual(held.conflicts)
      // Settling again leaves the same decision on the same revision.
      expect((await ensureDraft(d, env, owner)).revision).toBe(edited.revision)
      expect(
        await keepDraftValues(d, editor('ana'), {
          batchId: draftId,
          revision: edited.revision,
        })
      ).toEqual({ ok: false, error: 'forbidden' })

      expect(
        await keepDraftValues(d, owner, {
          batchId: draftId,
          revision: edited.revision,
        })
      ).toMatchObject({ ok: true })
      const kept = (await store.readBatch(draftId))!
      expect(kept.batch).toMatchObject({ baselineVersion: 23 })
      expect(kept.batch.conflicts).toBeUndefined()
      expect(kept.batch.stateOrders).toEqual({
        AL: ['AL.one', 'AL.two', 'AL.three'],
      })
      expect(fieldsOf(kept.edits)).toEqual({
        'AK.one': { tags: [] },
        'AK.three': { tags: ['three'] },
        'AK.four': { tags: ['four'] },
      })
      const next = await freezeRelease(d, env, owner, kept.batch.revision)
      if (!next.ok) throw new Error(next.error)
      const release = (await store.readBatch(next.value.id))!
      expect(fieldsOf(release.edits)).toEqual(fieldsOf(kept.edits))
      expect(release.batch.stateOrders).toEqual(kept.batch.stateOrders)
    },
    timeout
  )

  test(
    'an outside change that removes a plate with pending values keeps them as a conflict for the Owner',
    async () => {
      const { store, d, draftId, env, save, tag, outsideChange } = await setup()
      await ensureDraft(d, env, owner)
      await save(editor('ana'), 'AK.one', {
        tags: ['draft'],
        description: 'Draft text',
      })
      await tag(editor('ben'), 'AK.two', ['two'])
      outsideChange({ 'AK.one': null })

      const draft = await ensureDraft(d, env, owner)
      expect(draft.conflicts).toEqual([
        {
          kind: 'removed',
          plateId: 'AK.one',
          fields: { tags: ['draft'], description: 'Draft text' },
          fromVersion: 1,
          toVersion: 2,
        },
      ])
      expect(fieldsOf((await store.readBatch(draftId))!.edits)).toEqual({
        'AK.two': { tags: ['two'] },
      })
      expect(await freezeRelease(d, env, owner, draft.revision)).toEqual({
        ok: false,
        error: 'draft_conflicts',
      })
    },
    timeout
  )

  test(
    'a state order the draft published is not reintroduced after another publish restores the earlier order',
    async () => {
      const { store, d, draftId, env, commit, settle, publishElsewhere } =
        await setup()
      const draft = await ensureDraft(d, env, owner)
      expect(
        await reorderState(d, owner, {
          batchId: draftId,
          state: 'AL',
          batchRevision: draft.revision,
          order: ['AL.one', 'AL.three', 'AL.two'],
        })
      ).toMatchObject({ ok: true }) // revision 1
      const frozen = await freezeRelease(d, env, owner, 1)
      if (!frozen.ok) throw new Error(frozen.error)
      settle(await commit(frozen.value.id))
      // Before the draft settles, an old Batch puts Alabama back the way it was.
      settle(publishElsewhere({ AL: ['AL.one', 'AL.two', 'AL.three'] }))

      const settled = await ensureDraft(d, env, editor('cy'))
      expect(settled).toMatchObject({
        baselineVersion: 3,
        lastPublish: { releaseId: frozen.value.id, version: 2 },
      })
      expect(settled.stateOrders).toEqual({})
      expect((await store.getBatch(draftId))!.conflicts).toBeUndefined()
    },
    timeout
  )

  test(
    'a family grouping the publishing revision adds and a later revision discards ships as an ungrouped plate',
    async () => {
      const { store, d, draftId, env, save, publish, commit } = await setup()
      await ensureDraft(d, env, owner)
      await save(editor('ana'), 'AK.one', {
        templateFamily: 'AK.family',
        templateRole: 'template',
      }) // revision 1
      const frozen = await freezeRelease(d, env, owner, 1)
      if (!frozen.ok) throw new Error(frozen.error)
      expect(
        await discardPlateChanges(d, editor('ana'), {
          batchId: draftId,
          plateId: 'AK.one',
          batchRevision: 1,
          target: 'all',
        })
      ).toMatchObject({ ok: true }) // revision 2
      expect(await publish(frozen.value.id)).toMatchObject({ ok: true })

      // The next release ships the reset; commit builds and validates its Snapshot.
      const draft = (await store.getBatch(draftId))!
      const next = await freezeRelease(d, env, owner, draft.revision)
      if (!next.ok) throw new Error(next.error)
      const version = await commit(next.value.id)
      expect(await d.baselineAtVersion(version, 'AK.one')).toEqual(
        await d.baselineAtVersion(1, 'AK.one')
      )
    },
    timeout
  )

  test(
    'a Commons source the publishing revision adds to a kept image and a later revision discards ships without a source',
    async () => {
      const setupResult = await setup()
      const { store, d, draftId, env, save, publish, commit } = setupResult
      const image = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/AK.png'
      const start = setupResult.outsideChange({ 'AK.one': { imageUrl: image } })
      await ensureDraft(d, env, owner)
      await save(editor('ana'), 'AK.one', {
        imageUrl: image,
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:AK.png',
      }) // revision 1
      const frozen = await freezeRelease(d, env, owner, 1)
      if (!frozen.ok) throw new Error(frozen.error)
      expect(
        await discardPlateChanges(d, editor('ana'), {
          batchId: draftId,
          plateId: 'AK.one',
          batchRevision: 1,
          target: 'all',
        })
      ).toMatchObject({ ok: true }) // revision 2
      expect(await publish(frozen.value.id)).toMatchObject({ ok: true })
      expect(fieldsOf((await store.readBatch(draftId))!.edits)).toEqual({
        'AK.one': { sourceUrl: null },
      })

      // The next release ships the paired reset; commit builds and validates its Snapshot.
      const draft = (await store.getBatch(draftId))!
      const next = await freezeRelease(d, env, owner, draft.revision)
      if (!next.ok) throw new Error(next.error)
      const version = await commit(next.value.id)
      expect(await d.baselineAtVersion(version, 'AK.one')).toEqual(
        await d.baselineAtVersion(start, 'AK.one')
      )
    },
    timeout
  )

  test(
    'undoing a deletion the publishing revision ships is refused, and an undo that slips past is a conflict',
    async () => {
      const { store, d, draftId, env, save, publish } = await setup()
      await ensureDraft(d, env, owner)
      await save(editor('ana'), 'AK.five', { deleted: true }) // revision 1
      await save(editor('ana'), 'AK.six', { deleted: true }) // revision 2
      const frozen = await freezeRelease(d, env, owner, 2)
      if (!frozen.ok) throw new Error(frozen.error)
      // Undone before the Owner's confirmation lands: the undo is accepted.
      expect(
        await save(editor('ben'), 'AK.five', { deleted: false })
      ).toMatchObject({ ok: true })
      // Confirmed: the release is publishing, so a further undo is refused.
      expect(
        await store.commit(frozen.value.id, 0, {
          batch: {
            ...frozen.value,
            state: 'approved',
            revision: 1,
            approval: { revision: 0, by: owner.uid, at: d.now() },
          },
        })
      ).toBe('ok')
      expect(
        await save(editor('ben'), 'AK.six', { deleted: false })
      ).toMatchObject({
        ok: false,
        error: 'invalid_state',
        reasons: [expect.stringContaining('Revision 2')],
      })
      expect(
        await discardPlateChanges(d, editor('ben'), {
          batchId: draftId,
          plateId: 'AK.six',
          batchRevision: 3,
          target: 'deleted',
        })
      ).toMatchObject({
        ok: false,
        error: 'invalid_state',
        reasons: [expect.stringContaining('Revision 2')],
      })

      await publish(frozen.value.id)
      const draft = (await store.getBatch(draftId))!
      expect(draft.conflicts).toEqual([
        { kind: 'deleted', plateId: 'AK.five', fromVersion: 1, toVersion: 2 },
      ])
      expect(await freezeRelease(d, env, owner, draft.revision)).toEqual({
        ok: false,
        error: 'draft_conflicts',
      })
    },
    timeout
  )

  test(
    'the last publish names who published and when from the receipt, not who froze the release',
    async () => {
      const { store, d, draftId, env, tag, commit, settle } = await setup()
      await ensureDraft(d, env, owner)
      await tag(editor('ana'), 'AK.one', ['one'])
      const frozen = await freezeRelease(
        d,
        env,
        { uid: 'olive', name: 'Olive' },
        1
      )
      if (!frozen.ok) throw new Error(frozen.error)
      const version = await commit(frozen.value.id, {
        uid: 'bea',
        email: 'bea@example.com',
      })
      settle(version)
      const expected = {
        releaseId: frozen.value.id,
        revision: 1,
        version: 2,
        by: 'bea',
        byName: 'bea@example.com',
        at: '2026-11-18T12:00:02.000Z',
      }
      // A read gets there first; the delayed workflow step keeps the same record.
      expect((await ensureDraft(d, env, editor('cy'))).lastPublish).toEqual(
        expected
      )
      await afterPublish(d, frozen.value.id, version)
      expect((await store.getBatch(draftId))!.lastPublish).toEqual(expected)
    },
    timeout
  )

  test(
    'an outside catalog change to a pending field is a conflict the Owner resolves; an untouched pending field is not',
    async () => {
      const { store, d, draftId, env, save, outsideChange } = await setup()
      await ensureDraft(d, env, owner)
      await save(editor('ana'), 'AK.one', {
        tags: ['draft'],
        description: 'Draft text',
      })
      outsideChange({ 'AK.one': { tags: ['live'] } })

      const draft = await ensureDraft(d, env, owner)
      expect(draft).toMatchObject({
        baselineVersion: 2,
        conflicts: [
          {
            kind: 'field',
            plateId: 'AK.one',
            field: 'tags',
            fromVersion: 1,
            toVersion: 2,
          },
        ],
      })
      expect(fieldsOf((await store.readBatch(draftId))!.edits)).toEqual({
        'AK.one': { tags: ['draft'], description: 'Draft text' },
      })
      expect(await freezeRelease(d, env, owner, draft.revision)).toEqual({
        ok: false,
        error: 'draft_conflicts',
      })

      // Changing the conflicting field resolves it.
      await save(editor('ana'), 'AK.one', { tags: ['draft', 'checked'] })
      const resolved = (await store.getBatch(draftId))!
      expect(resolved.conflicts).toBeUndefined()
      expect(
        await freezeRelease(d, env, owner, resolved.revision)
      ).toMatchObject({ ok: true })
    },
    timeout
  )

  test(
    "the Owner can keep the draft's values over an outside change, and only the Owner",
    async () => {
      const { store, d, draftId, env, tag, outsideChange } = await setup()
      await ensureDraft(d, env, owner)
      await tag(editor('ana'), 'AK.one', ['draft'])
      outsideChange({ 'AK.one': { tags: ['live'] } })
      const draft = await ensureDraft(d, env, owner)
      expect(draft.conflicts).toHaveLength(1)
      expect(
        await keepDraftValues(d, editor('ana'), {
          batchId: draftId,
          revision: draft.revision,
        })
      ).toMatchObject({ ok: false, error: 'forbidden' })
      expect(
        await keepDraftValues(d, owner, {
          batchId: draftId,
          revision: draft.revision - 1,
        })
      ).toMatchObject({ ok: false, error: 'superseded_revision' })
      expect(
        await keepDraftValues(d, owner, {
          batchId: draftId,
          revision: draft.revision,
        })
      ).toMatchObject({
        ok: true,
      })
      const kept = (await store.readBatch(draftId))!
      expect(kept.batch.conflicts).toBeUndefined()
      expect(fieldsOf(kept.edits)).toEqual({ 'AK.one': { tags: ['draft'] } })
    },
    timeout
  )

  test(
    'a Standard change is saved on a draft that already tracks more than 1,000 plates',
    async () => {
      const { store, d, draftId, env, save } = await setup()
      const draft = await ensureDraft(d, env, owner)
      // The old per-Batch cap was 1,000 plates; the shared draft allows 10,000.
      const tracked = Array.from({ length: 1_001 }, (_, i) => `ZZ.${i}`)
      expect(
        await store.commit(draftId, draft.revision, {
          batch: { ...draft, plateIds: tracked, revision: draft.revision + 1 },
          history: false,
        })
      ).toBe('ok')
      expect(
        await save(owner, 'AK.two', { templateRole: 'template' })
      ).toMatchObject({ ok: true })
      const order = ['two', 'one', 'three', 'four', 'five', 'six']
      expect(
        await reorderState(d, owner, {
          batchId: draftId,
          state: 'AK',
          batchRevision: draft.revision + 2,
          order: order.map((n) => `AK.${n}`),
          standard: { from: null, to: 'AK.two' },
        })
      ).toMatchObject({ ok: true })
      const head = (await store.getBatch(draftId))!
      expect(head.plateIds).toHaveLength(1_002)
      expect(head.stateOrders.AK?.[0]).toBe('AK.two')
      expect(await store.getEdit(draftId, 'AK.two')).toMatchObject({
        fields: { templateRole: 'template', isStandard: true },
      })
    },
    timeout
  )
}
