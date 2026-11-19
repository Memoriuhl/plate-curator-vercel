import type { Plate } from '../../catalog/types'
import { applyReleaseEdits } from '../../publish/apply-edits'
import { validateSnapshot } from '../../publish/validation'
import { validRegroup } from '../batches/batch'
import { deletionPublishing, resolveConflicts } from './draft'
import { draftGroupingFields } from '../fields'
import { hasPipelineHistory } from '../pipeline-changes'
import { retryDraft } from '../preconditions'
import { plateRevision } from '../revision'
import { writeBytes } from '../write-budget'
import type {
  Actor,
  EditableFields,
  Outcome,
  ProposedEdit,
  ReviewBatch,
  ReviewDeps,
} from '../types'

type Change = {
  baseline: Plate
  previous: ProposedEdit
  fields: EditableFields
  restored: (keyof EditableFields)[]
  pipelineChanges?: ProposedEdit['pipelineChanges']
  discardAll?: boolean
}
type OrderChange = { state: string; baseline: string[]; order: string[] }

/** Check the same projected plates that Publish validates for each state the revert changes structurally. */
async function validateRevert(
  d: ReviewDeps,
  batch: ReviewBatch,
  edits: ProposedEdit[],
  changes: Change[],
  order?: OrderChange
): Promise<string[]> {
  const grouping = new Set<keyof EditableFields>([
    ...draftGroupingFields,
    'deleted',
  ])
  const structural = changes.filter((change) =>
    change.restored.some(
      (field) => grouping.has(field) || field === 'isStandard'
    )
  )
  const states = Map.groupBy(structural, (change) => change.baseline.state)
  if (order && !states.has(order.state)) states.set(order.state, [])
  if (!states.size) return []

  const version = batch.baselineVersion
  const jurisdictions = await Promise.all(
    [...states.keys()].map(
      async (state) => [state, await d.stateBaseline(version, state)] as const
    )
  )
  const snapshot = d.snapshotAtVersion
    ? await d.snapshotAtVersion(version)
    : { version, plates: jurisdictions.flatMap(([, plates]) => plates) }
  const beforeOrders: Record<string, string[]> = {}
  const afterOrders: Record<string, string[]> = {}
  for (const [state, plates] of jurisdictions) {
    const saved = batch.stateOrders[state]
    const live =
      batch.baselineOrders?.[state] ?? plates.map((plate) => plate.id)
    beforeOrders[state] = saved ?? live
    afterOrders[state] = order?.state === state ? order.order : (saved ?? live)
  }

  const fields = new Map(edits.map((edit) => [edit.plateId, edit]))
  for (const change of changes)
    fields.set(change.baseline.id, {
      ...change.previous,
      fields: change.fields,
    })
  const before = applyReleaseEdits(snapshot.plates, edits, beforeOrders)
  const after = applyReleaseEdits(
    snapshot.plates,
    [...fields.values()],
    afterOrders
  )
  const target = version + 1
  const existing = new Set(
    validateSnapshot(
      snapshot,
      { version: target, plates: before.plates },
      before.deleted,
      beforeOrders
    )
  )
  const reasons = validateSnapshot(
    snapshot,
    { version: target, plates: after.plates },
    after.deleted,
    afterOrders
  ).filter((reason) => !existing.has(reason))

  const afterByState = Map.groupBy(after.plates, (plate) => plate.state)
  for (const [state, affected] of states) {
    const familyChanges = affected.filter((change) =>
      change.restored.some((field) => grouping.has(field))
    )
    if (!familyChanges.length) continue
    const families = new Set(
      familyChanges.flatMap(({ baseline, previous, fields }) => [
        { ...baseline, ...previous.fields }.templateFamily,
        { ...baseline, ...fields }.templateFamily,
      ])
    )
    const ids = new Set(familyChanges.map(({ baseline }) => baseline.id))
    const members = new Map(
      (afterByState.get(state) ?? []).map((plate) => [plate.id, plate])
    )
    if (!validRegroup(members, families, ids))
      reasons.push(
        `Revert would leave a family in ${state} without a valid Template or Variant parent.`
      )
  }
  return reasons
}

/** Apply the eligible reversals together at the revision used to plan them. */
export async function commitDraftRevert(
  d: ReviewDeps,
  actor: Actor,
  snapshot: { batch: ReviewBatch; edits: ProposedEdit[] },
  changes: Change[],
  order?: OrderChange
): Promise<Outcome<ReviewBatch> | typeof retryDraft> {
  const { batch, edits } = snapshot
  if (!changes.length && !order) return { ok: true, value: batch }

  let deletionPublishFence: number | undefined
  for (const { baseline, previous, fields } of changes) {
    const restored = { ...baseline, ...fields }
    if (previous.fields.deleted && !restored.deleted) {
      deletionPublishFence ??= await d.store.deletionPublishFence?.(batch.id)
      const reason = await deletionPublishing(d, batch, baseline.id)
      if (reason)
        return { ok: false, error: 'invalid_state', reasons: [reason] }
    }
  }
  const reasons = await validateRevert(d, batch, edits, changes, order)
  if (reasons.length) return { ok: false, error: 'invalid_state', reasons }

  const at = d.now()
  let next: ReviewBatch = {
    ...batch,
    state: 'open',
    approval: null,
    lastChangedAt: at,
    revision: batch.revision + 1,
  }
  const updates: ProposedEdit[] = []
  const deletes: string[] = []
  for (const change of changes) {
    const {
      baseline,
      previous,
      fields,
      restored,
      pipelineChanges,
      discardAll,
    } = change
    const { pipelineChanges: previousAttribution, ...keep } = previous
    const attribution = { ...previousAttribution, ...pipelineChanges }
    for (const field of restored)
      if (!pipelineChanges?.[field]) delete attribution[field]
    const edit = {
      ...keep,
      ...(Object.keys(attribution).length
        ? { pipelineChanges: attribution }
        : {}),
      fields,
      authorId: actor.uid,
      authorName: actor.name,
      updatedAt: at,
      baseRevision: plateRevision(baseline),
      resultRevision: plateRevision({ ...baseline, ...fields }),
    }
    if (
      discardAll ||
      (!Object.keys(fields).length && !hasPipelineHistory(edit))
    )
      deletes.push(baseline.id)
    else updates.push(edit)
    if (discardAll)
      next.plateIds = next.plateIds.filter((id) => id !== baseline.id)
    if (restored.length || discardAll)
      next = resolveConflicts(next, {
        plateId: baseline.id,
        fields: discardAll ? undefined : restored,
      })
  }
  if (order) {
    const { state, baseline, order: ids } = order
    next = resolveConflicts(next, { state })
    next.stateOrders = { ...batch.stateOrders }
    next.stateOrderChangedAt = { ...batch.stateOrderChangedAt }
    if (
      ids.length === baseline.length &&
      ids.every((id, index) => id === baseline[index])
    ) {
      delete next.stateOrders[state]
      delete next.stateOrderChangedAt[state]
    } else {
      next.stateOrders[state] = ids
      next.stateOrderChangedAt[state] = at
    }
  }
  // The shared draft records all before-images together in a single Firestore document.
  if (
    batch.kind === 'shared-draft' &&
    writeBytes(changes.map(({ previous }) => previous)) > 900_000
  )
    return {
      ok: false,
      error: 'invalid_state',
      reasons: [
        'This run is too large to revert in one draft revision. Revert its fields individually.',
      ],
    }

  const result = await d.store.commit(batch.id, batch.revision, {
    batch: next,
    by: actor,
    edits: updates,
    deleteEditsFor: deletes,
    deletionPublishFence,
  })
  if (result === 'revision_mismatch') return retryDraft
  if (result !== 'ok') return { ok: false, error: result }
  return { ok: true, value: next }
}
