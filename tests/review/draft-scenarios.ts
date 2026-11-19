import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import type { Plate } from '../../lib/catalog/types'
import { proposeEdit, reorderState } from '../../lib/review/batch'
import {
  afterPublish,
  draftAtRevision,
  ensureDraft,
  freezeRelease,
} from '../../lib/review/draft'
import { sharedDraftId } from '../../lib/review/draft-id'
import { draftCommitAttempts } from '../../lib/review/retry'
import { plateRevision } from '../../lib/review/revision'
import type {
  Actor,
  ProposedEdit,
  ReviewDeps,
  ReviewStore,
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
      now: () => new Date().toISOString(),
    }
    const draftId = sharedDraftId(env)
    /** Save tags on one plate from the draft's current value. */
    const tag = async (actor: Actor, id: string, tags: string[]) => {
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
        fields: { tags },
      })
    }
    /** Publish a release: the catalog moves to a new version with its edits applied. */
    const publish = async (releaseId: string) => {
      const release = (await store.readBatch(releaseId))!
      const edits = new Map(
        release.edits.map((entry) => [entry.plateId, entry])
      )
      const next = live + 1
      versions.set(
        next,
        versions
          .get(live)!
          .map((entry) => ({ ...entry, ...edits.get(entry.id)?.fields }))
      )
      live = next
      return afterPublish(d, releaseId, next)
    }
    return { env, store, d, draftId, tag, publish }
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
}
