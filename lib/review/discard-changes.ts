import { canEdit, editableStates } from './access'
import { retryDraft, retryDraftRace, unchangedSince } from './preconditions'
import { validRegroup } from './batch'
import { deletionPublishing, resolveConflicts } from './draft'
import { familyRole } from '../catalog/families'
import { orderDifferences, restorePlateOrder } from './order-diff'
import { draftGroupingFields, editableKeys } from './fields'
import {
  hasPipelineHistory,
  pipelineImageFields,
  retainedPipelineChanges,
} from './pipeline-changes'
import { plateRevision } from './revision'
import type {
  Actor,
  DraftChangeTarget,
  EditableFields,
  Outcome,
  ProposedEdit,
  ReviewBatch,
  ReviewDeps,
} from './types'

type DiscardInput = {
  batchId: string
  plateId: string
  batchRevision: number
  target: DraftChangeTarget
}

export function discardPlateChanges(
  d: ReviewDeps,
  actor: Actor,
  input: DiscardInput
): Promise<Outcome<ReviewBatch>> {
  return retryDraftRace(() => discardPlateChangesOnce(d, actor, input))
}

async function discardPlateChangesOnce(
  d: ReviewDeps,
  actor: Actor,
  input: DiscardInput
): Promise<Outcome<ReviewBatch> | typeof retryDraft> {
  const snapshot = await d.store.readBatch(input.batchId)
  if (!snapshot) return { ok: false, error: 'not_found' }
  const { batch, edits } = snapshot
  if (!canEdit(batch, actor)) return { ok: false, error: 'forbidden' }
  if (
    !(await unchangedSince(d, batch, input.batchRevision, {
      plateIds: [input.plateId],
      orderStates:
        input.target === 'order' || input.target === 'all'
          ? [input.plateId.split('.')[0]]
          : [],
    }))
  )
    return { ok: false, error: 'superseded_revision' }
  if (!editableStates.includes(batch.state))
    return { ok: false, error: 'invalid_state' }

  const { plateId, target } = input
  const baseline = await d.baselineAtVersion(batch.baselineVersion, plateId)
  if (!baseline) return { ok: false, error: 'not_found' }
  const state = baseline.state
  const byId = new Map(edits.map((edit) => [edit.plateId, edit]))
  const existing = byId.get(plateId)
  const dropAll = target === 'all'
  const fieldsToRemove =
    target === 'all'
      ? editableKeys
      : target === 'order'
        ? []
        : draftGroupingFields.some((field) => field === target)
          ? draftGroupingFields
          : target === 'imageUrl' ||
              (target === 'sourceUrl' &&
                Object.hasOwn(existing?.fields ?? {}, 'imageUrl'))
            ? pipelineImageFields
            : [target]
  const removed = fieldsToRemove.filter((field) =>
    Object.hasOwn(existing?.fields ?? {}, field)
  )
  const resetStandard = removed.includes('isStandard')
  const validateFamily = removed.some(
    (field) =>
      field === 'deleted' || draftGroupingFields.some((key) => key === field)
  )
  const oldOrder = batch.stateOrders[state]
  const restoreOrder =
    !!oldOrder && (dropAll || target === 'order' || resetStandard)
  const statePlates =
    validateFamily || restoreOrder || resetStandard
      ? await d.stateBaseline(batch.baselineVersion, state)
      : []
  const baselineOrder =
    batch.baselineOrders?.[state] ?? statePlates.map((plate) => plate.id)
  const moved =
    restoreOrder &&
    orderDifferences(baselineOrder, oldOrder).some(
      (item) => item.plateId === plateId
    )
  const standardIds = resetStandard
    ? statePlates
        .filter((plate) =>
          Object.hasOwn(byId.get(plate.id)?.fields ?? {}, 'isStandard')
        )
        .map((plate) => plate.id)
    : []

  let order = moved
    ? restorePlateOrder(baselineOrder, oldOrder, plateId)
    : oldOrder
  if (order && resetStandard) {
    for (const id of standardIds)
      order = restorePlateOrder(baselineOrder, order, id)
  }
  if (!removed.length && !moved && !(dropAll && existing))
    return { ok: true, value: batch }
  if (removed.includes('deleted')) {
    const publishing = await deletionPublishing(d, batch, plateId)
    if (publishing)
      return { ok: false, error: 'invalid_state', reasons: [publishing] }
  }

  const changedAt = d.now()
  const nextEdits: ProposedEdit[] = []
  const deletedEdits: string[] = []
  const changedFields = new Map<string, EditableFields>()
  const bases = new Map(statePlates.map((plate) => [plate.id, plate]))
  bases.set(plateId, baseline)
  for (const id of new Set([plateId, ...standardIds])) {
    const previous = byId.get(id)
    if (!previous || (id === plateId && !removed.length && !dropAll)) continue
    const clear = id === plateId ? removed : (['isStandard'] as const)
    const fields = { ...previous.fields }
    for (const field of clear) delete fields[field]
    if (id === plateId && dropAll) {
      changedFields.set(id, {})
      deletedEdits.push(id)
      continue
    }
    changedFields.set(id, fields)
    const base = bases.get(id)!
    const plate = { ...base, ...fields }
    const attribution = retainedPipelineChanges(previous, plate)
    for (const field of clear) delete attribution.pipelineChanges?.[field]
    const edit = {
      ...attribution,
      plateId: id,
      fields,
      authorId: actor.uid,
      authorName: actor.name,
      updatedAt: changedAt,
      baseRevision: plateRevision(base),
      resultRevision: plateRevision(plate),
    }
    if (Object.keys(fields).length || hasPipelineHistory(edit))
      nextEdits.push(edit)
    else deletedEdits.push(id)
  }

  const effective = new Map(
    statePlates.map((plate) => [
      plate.id,
      {
        ...plate,
        ...(changedFields.get(plate.id) ?? byId.get(plate.id)?.fields),
      },
    ])
  )
  if (validateFamily) {
    const previous = { ...baseline, ...existing?.fields }
    const after = { ...baseline, ...changedFields.get(plateId) }
    const families = new Set(
      [previous.templateFamily, after.templateFamily].filter(Boolean)
    )
    if (!validRegroup(effective, families, new Set([plateId])))
      return {
        ok: false,
        error: 'invalid_state',
        reasons: [
          'Remove the related family changes before removing this one.',
        ],
      }
  }
  const first = (order ?? baselineOrder)[0]
  if (
    resetStandard ||
    (order &&
      (first !== oldOrder?.[0] || (first === plateId && validateFamily)))
  ) {
    const standards = [...effective.values()].filter(
      (plate) => !plate.deleted && plate.isStandard
    )
    const baselineStandards = statePlates.filter(
      (plate) => !plate.deleted && plate.isStandard
    )
    const restoresBaseline =
      resetStandard &&
      first === baselineOrder[0] &&
      baselineStandards.length === standards.length &&
      baselineStandards.every(
        (plate, index) =>
          plate.id === standards[index].id &&
          familyRole(plate) === familyRole(standards[index])
      )
    if (
      !restoresBaseline &&
      (standards.length !== 1 ||
        standards[0].id !== first ||
        familyRole(standards[0]) !== 'template')
    ) {
      return {
        ok: false,
        error: 'invalid_state',
        reasons: [
          'Remove the related Standard or order change first to keep the Standard at the top.',
        ],
      }
    }
  }

  let next: ReviewBatch = resolveConflicts(
    {
      ...batch,
      state: 'open',
      approval: null,
      revision: batch.revision + 1,
      lastChangedAt: changedAt,
      plateIds: dropAll
        ? batch.plateIds.filter((id) => id !== plateId)
        : batch.plateIds,
    },
    { plateId, fields: dropAll ? undefined : removed }
  )
  if (order && order !== oldOrder) {
    next = resolveConflicts(next, { state })
    next.stateOrders = { ...batch.stateOrders }
    next.stateOrderChangedAt = { ...batch.stateOrderChangedAt }
    if (
      order.length === baselineOrder.length &&
      order.every((id, index) => id === baselineOrder[index])
    ) {
      delete next.stateOrders[state]
      delete next.stateOrderChangedAt[state]
    } else {
      next.stateOrders[state] = order
      next.stateOrderChangedAt[state] = changedAt
    }
  }
  const result = await d.store.commit(batch.id, batch.revision, {
    batch: next,
    by: actor,
    edits: nextEdits,
    deleteEditsFor: deletedEdits,
  })
  if (result === 'revision_mismatch') return retryDraft
  if (result !== 'ok') return { ok: false, error: result }
  return { ok: true, value: next }
}
