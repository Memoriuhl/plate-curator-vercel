import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import type { Plate } from '../../lib/catalog/types'
import { proposeEdit, reorderState } from '../../lib/review/batch'
import { discardPlateChanges } from '../../lib/review/discard-changes'
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
/** A plate fixture with no tags. */
const plate = (id: string): Plate => ({
  id,
  state: id.split('.')[0],
  slug: id,
  displayName: id,
  image: `${id}.png`,
  tags: [],
})
const v1 = [
  ...['one', 'two', 'three', 'four', 'five', 'six'].map((n) =>
    plate(`AK.${n}`)
  ),
  ...['one', 'two', 'three'].map((n) => plate(`AL.${n}`)),
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
  async function setup() {
    const env = `draft-${randomUUID().slice(0, 8)}`
    const store = await makeStore(env)
    const versions = new Map<number, Plate[]>([[1, v1]])
    // Committed publish receipts by the version they moved the pointer to.
    const origins = new Map<number, VersionOrigin>()
    let live = 1
    const d: ReviewDeps = {
      store,
      baseline: async (id) =>
        versions.get(live)!.find((entry) => entry.id === id) ?? null,
      baselineAtVersion: async (version, id) =>
        versions.get(version)?.find((entry) => entry.id === id) ?? null,
      stateBaseline: async (version, state) =>
        (versions.get(version) ?? []).filter((entry) => entry.state === state),
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
     * Commit a release the way Publish does: the pointer moves to a new version with its
     * edits applied (deleted plates removed) and the receipt records who asked and when.
     * The receipt stays unsettled until `settle`, as it is while the state order
     * projection is still being written.
     */
    const commit = async (
      releaseId: string,
      by: { uid: string; email: string } = { uid: 'owner', email: 'owner@x' }
    ) => {
      const release = (await store.readBatch(releaseId))!
      const edits = new Map(
        release.edits.map((entry) => [entry.plateId, entry])
      )
      const next = live + 1
      versions.set(
        next,
        versions
          .get(live)!
          .filter((entry) => !edits.get(entry.id)?.fields.deleted)
          .map((entry) => ({ ...entry, ...edits.get(entry.id)?.fields }))
      )
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
    /** Move the pointer outside any release of this draft, changing some plates. */
    const outsideChange = (changes: Record<string, Partial<Plate>>) => {
      const next = live + 1
      versions.set(
        next,
        versions.get(live)!.map((entry) => ({ ...entry, ...changes[entry.id] }))
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
