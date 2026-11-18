import { canEdit, editableStates } from './access'
import { validRegroup } from './batch'
import { familyRole } from '../catalog/families'
import { orderDifferences, restorePlateOrder } from './order-diff'
import { draftGroupingFields, editableKeys } from './fields'
import { hasPipelineHistory, pipelineImageFields, retainedPipelineChanges } from './pipeline-changes'
import { plateRevision } from './revision'
import type { Actor, DraftChangeTarget, EditableFields, Outcome, ProposedEdit, ReviewBatch, ReviewDeps } from './types'

export async function discardPlateChanges(d: ReviewDeps, actor: Actor, input: {
  batchId: string; plateId: string; batchRevision: number; target: DraftChangeTarget
}): Promise<Outcome<ReviewBatch>> {
  const snapshot = await d.store.readBatch(input.batchId)
  if (!snapshot) return { ok: false, error: 'not_found' }
  const { batch, edits } = snapshot
  if (!canEdit(batch, actor)) return { ok: false, error: 'forbidden' }
  if (batch.revision !== input.batchRevision) return { ok: false, error: 'superseded_revision' }
  if (!editableStates.includes(batch.state)) return { ok: false, error: 'invalid_state' }

  const { plateId, target } = input
  const baseline = await d.baselineAtVersion(batch.baselineVersion, plateId)
  if (!baseline) return { ok: false, error: 'not_found' }
  const state = baseline.state
  const byId = new Map(edits.map(edit => [edit.plateId, edit]))
  const existing = byId.get(plateId)
  const dropAll = target === 'all'
  const fieldsToRemove = target === 'all' ? editableKeys : target === 'order' ? []
    : draftGroupingFields.some(field => field === target) ? draftGroupingFields
      : target === 'imageUrl' || target === 'sourceUrl' && Object.hasOwn(existing?.fields ?? {}, 'imageUrl') ? pipelineImageFields
        : [target]
  const removed = fieldsToRemove.filter(field => Object.hasOwn(existing?.fields ?? {}, field))
  const resetStandard = removed.includes('isStandard')
  const validateFamily = removed.some(field => field === 'deleted' || draftGroupingFields.some(key => key === field))
  const oldOrder = batch.stateOrders[state]
  const restoreOrder = !!oldOrder && (dropAll || target === 'order' || resetStandard)
  const statePlates = validateFamily || restoreOrder || resetStandard ? await d.stateBaseline(batch.baselineVersion, state) : []
  const baselineOrder = batch.baselineOrders?.[state] ?? statePlates.map(plate => plate.id)
  const moved = restoreOrder && orderDifferences(baselineOrder, oldOrder).some(item => item.plateId === plateId)
  const standardIds = resetStandard ? statePlates.filter(plate => Object.hasOwn(byId.get(plate.id)?.fields ?? {}, 'isStandard')).map(plate => plate.id) : []

  let order = moved ? restorePlateOrder(baselineOrder, oldOrder, plateId) : oldOrder
  if (order && resetStandard) {
    for (const id of standardIds) order = restorePlateOrder(baselineOrder, order, id)
  }
  if (!removed.length && !moved && !(dropAll && existing)) return { ok: true, value: batch }

  const changedAt = d.now()
  const nextEdits: ProposedEdit[] = []
  const deletedEdits: string[] = []
  const changedFields = new Map<string, EditableFields>()
  const bases = new Map(statePlates.map(plate => [plate.id, plate]))
  bases.set(plateId, baseline)
  for (const id of new Set([plateId, ...standardIds])) {
    const previous = byId.get(id)
    if (!previous || id === plateId && !removed.length && !dropAll) continue
    const clear = id === plateId ? removed : ['isStandard'] as const
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
    const edit = { ...attribution, plateId: id, fields, authorId: actor.uid, authorName: actor.name, updatedAt: changedAt, baseRevision: plateRevision(base), resultRevision: plateRevision(plate) }
    if (Object.keys(fields).length || hasPipelineHistory(edit)) nextEdits.push(edit)
    else deletedEdits.push(id)
  }

  const effective = new Map(statePlates.map(plate => [plate.id, { ...plate, ...(changedFields.get(plate.id) ?? byId.get(plate.id)?.fields) }]))
  if (validateFamily) {
    const previous = { ...baseline, ...existing?.fields }
    const after = { ...baseline, ...changedFields.get(plateId) }
    const families = new Set([previous.templateFamily, after.templateFamily].filter(Boolean))
    if (!validRegroup(effective, families, new Set([plateId]))) return { ok: false, error: 'invalid_state', reasons: ['Remove the related family changes before removing this one.'] }
  }
  const first = (order ?? baselineOrder)[0]
  if (resetStandard || order && (first !== oldOrder?.[0] || first === plateId && validateFamily)) {
    const standards = [...effective.values()].filter(plate => !plate.deleted && plate.isStandard)
    const baselineStandards = statePlates.filter(plate => !plate.deleted && plate.isStandard)
    const restoresBaseline = resetStandard && first === baselineOrder[0] && baselineStandards.length === standards.length &&
      baselineStandards.every((plate, index) => plate.id === standards[index].id && familyRole(plate) === familyRole(standards[index]))
    if (!restoresBaseline && (standards.length !== 1 || standards[0].id !== first || familyRole(standards[0]) !== 'template')) {
      return { ok: false, error: 'invalid_state', reasons: ['Remove the related Standard or order change first to keep the Standard at the top.'] }
    }
  }

  const next: ReviewBatch = { ...batch, state: 'open', approval: null, revision: batch.revision + 1, lastChangedAt: changedAt,
    plateIds: dropAll ? batch.plateIds.filter(id => id !== plateId) : batch.plateIds }
  if (order && order !== oldOrder) {
    next.stateOrders = { ...batch.stateOrders }
    if (order.length === baselineOrder.length && order.every((id, index) => id === baselineOrder[index])) delete next.stateOrders[state]
    else next.stateOrders[state] = order
  }
  const result = await d.store.commit(batch.id, batch.revision, { batch: next, by: actor, edits: nextEdits, deleteEditsFor: deletedEdits })
  if (result !== 'ok') return { ok: false, error: result === 'pipeline_busy' ? result : 'superseded_revision' }
  if (batch.state !== 'open') await d.supersedeRun?.(batch)
  return { ok: true, value: next }
}
