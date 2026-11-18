import { standardEdits, standardOrderProblems } from './standard'
import { canEdit, editableStates } from './access'
export { canEdit } from './access'
import type { Plate } from '../catalog/types'
import { editableKeys, limits } from './fields'
import { sameEditableValue } from './story'
import { plateRevision } from './revision'
import type { Actor, EditableFields, Outcome, ReviewBatch, ReviewDeps, StandardChange } from './types'

export async function proposeEdit(
  d: ReviewDeps,
  a: Actor,
  i: { batchId: string; plateId: string; baseRevision: string; fields: EditableFields; standard?: StandardChange },
): Promise<Outcome<{ batch: ReviewBatch; plate: Plate }>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const batch = await d.store.getBatch(i.batchId)
    if (!batch) return { ok: false, error: 'not_found' }
    if (!canEdit(batch, a)) return { ok: false, error: 'forbidden' }
    if (!editableStates.includes(batch.state)) return { ok: false, error: 'invalid_state' }
    const baseline = await d.baselineAtVersion(batch.baselineVersion, i.plateId)
    if (!baseline) return { ok: false, error: 'not_found' }
    const plateIds = batch.plateIds.includes(i.plateId) ? batch.plateIds : [...batch.plateIds, i.plateId]
    if (plateIds.length > limits.plates) return { ok: false, error: 'invalid_state' }
    const existing = await d.store.getEdit(i.batchId, i.plateId)
    const current = { ...baseline, ...existing?.fields }
    if (plateRevision(current) !== i.baseRevision) return { ok: false, error: 'stale_plate', current }
    const changes = Object.fromEntries(editableKeys
      .filter(key => i.fields[key] !== undefined && !sameEditableValue(key, current[key], i.fields[key]))
      .map(key => [key, i.fields[key]]))
    const plate = { ...current, ...changes }
    if (current.isStandard && (i.fields.isStandard === false || i.fields.templateRole !== undefined && plate.templateRole !== 'template')) return { ok: false, error: 'standard_required' }
    if (!plate.deleted && (plate.variantOfPlateId || plate.templateFamily)) {
      const edits = await d.store.listEdits(batch.id)
      const deleted = edits.filter(edit => edit.plateId !== plate.id && edit.fields.deleted)
      if (deleted.some(edit => edit.plateId === plate.variantOfPlateId)) return { ok: false, error: 'invalid_state' }
      if (plate.templateFamily) {
        const parents = await Promise.all(deleted.map(async edit => ({
          ...await d.baselineAtVersion(batch.baselineVersion, edit.plateId), ...edit.fields,
        })))
        if (parents.some(parent => parent.templateRole === 'template' && parent.templateFamily === plate.templateFamily)) return { ok: false, error: 'invalid_state' }
      }
    }
    if (plate.deleted) {
      if (plate.isStandard) return { ok: false, error: 'invalid_state' }
      const [plates, edits] = await Promise.all([
        d.stateBaseline(batch.baselineVersion, plate.state),
        d.store.listEdits(batch.id),
      ])
      const fieldsById = new Map(edits.map(edit => [edit.plateId, edit.fields]))
      const hasLinkedPlates = plates.some(baseline => {
        const member = { ...baseline, ...fieldsById.get(baseline.id) }
        return member.id !== plate.id && !member.deleted
          && (member.variantOfPlateId === plate.id || plate.templateRole === 'template' && member.templateRole !== 'template'
            && !!plate.templateFamily && member.templateFamily === plate.templateFamily)
      })
      if (hasLinkedPlates) return { ok: false, error: 'invalid_state' }
    }
    if (!plate.deleted && baseline.deleted === undefined) delete plate.deleted
    const fields: EditableFields = Object.fromEntries(editableKeys
      .filter(key => !sameEditableValue(key, baseline[key], plate[key]))
      .map(key => [key, plate[key]]))
    const nextBatch: ReviewBatch = { ...batch, plateIds, state: 'open', revision: batch.revision + 1, approval: null }
    const edit = {
      plateId: i.plateId, baseRevision: plateRevision(baseline), fields,
      authorId: a.uid, updatedAt: d.now(), resultRevision: plateRevision(plate),
    }
    let combined: Awaited<ReturnType<typeof standardEdits>> | undefined
    const firstId = batch.stateOrders[plate.state]?.[0]
    const affectsStandard = (current.isStandard || plate.id === firstId) && ['isStandard', 'templateRole', 'deleted', 'variantOfPlateId'].some(key => Object.hasOwn(i.fields, key))
    if (i.fields.isStandard === true || firstId && affectsStandard) {
      const baselinePlates = await d.stateBaseline(batch.baselineVersion, plate.state)
      let order = batch.stateOrders[plate.state] ?? baselinePlates.map(member => member.id)
      if (i.fields.isStandard === true) {
        if (plate.deleted || plate.templateRole !== 'template') return { ok: false, error: 'standard_invalid_template' }
        const existingEdits = await d.store.listEdits(batch.id)
        const effectiveFields = new Map(existingEdits.map(edit => [edit.plateId, edit.fields]))
        const familyIds = new Set(baselinePlates.filter(member => {
          const effective = { ...member, ...effectiveFields.get(member.id) }
          return member.id === plate.id || effective.variantOfPlateId === plate.id || !!plate.templateFamily && effective.templateFamily === plate.templateFamily
        }).map(member => member.id))
        order = [plate.id, ...order.filter(id => id !== plate.id && familyIds.has(id)), ...order.filter(id => !familyIds.has(id))]
      }
      combined = await standardEdits(d, a, batch, baselinePlates, order, new Map([[plate.id, changes]]), i.standard)
      if (!combined.ok) return combined
      nextBatch.plateIds = combined.value.plateIds
      nextBatch.stateOrders = { ...batch.stateOrders, [plate.state]: order }
      nextBatch.baselineOrders = { ...batch.baselineOrders, [plate.state]: batch.baselineOrders?.[plate.state] ?? baselinePlates.map(member => member.id) }
    }
    const result = await d.store.commit(i.batchId, batch.revision, {
      batch: nextBatch,
      ...(combined?.ok ? combined.value : Object.keys(fields).length === 0 ? { deleteEditFor: i.plateId } : { edit }),
    })
    if (result === 'ok') {
      if (batch.state !== 'open') await d.supersedeRun?.(batch)
      return { ok: true, value: { batch: nextBatch, plate } }
    }
  }
  return { ok: false, error: 'superseded_revision' }
}

export async function submitBatch(d: ReviewDeps, a: Actor, batchId: string, revision: number): Promise<Outcome<ReviewBatch>> {
  return transitionBatch(d, a, batchId, revision, 'submitted')
}

export async function approveBatch(d: ReviewDeps, a: Actor, batchId: string, revision: number): Promise<Outcome<ReviewBatch>> {
  if (a.role !== 'owner') return { ok: false, error: 'forbidden' }
  return transitionBatch(d, a, batchId, revision, 'approved')
}

async function transitionBatch(
  d: ReviewDeps, a: Actor, batchId: string, revision: number, state: 'submitted' | 'approved',
): Promise<Outcome<ReviewBatch>> {
  const batch = await d.store.getBatch(batchId)
  if (!batch) return { ok: false, error: 'not_found' }
  if (!canEdit(batch, a)) return { ok: false, error: 'forbidden' }
  if (batch.revision !== revision) return { ok: false, error: 'superseded_revision' }
  if (batch.state !== (state === 'submitted' ? 'open' : 'submitted')) return { ok: false, error: 'invalid_state' }
  if (state === 'submitted' || state === 'approved') {
    const edits = await d.store.listEdits(batch.id)
    const standardPlates = await Promise.all(edits.filter(edit => Object.hasOwn(edit.fields, 'isStandard')).map(edit => d.baselineAtVersion(batch.baselineVersion, edit.plateId)))
    const touchedStates = new Set([...Object.keys(batch.stateOrders), ...standardPlates.flatMap(plate => plate ? [plate.state] : [])])
    const states = await Promise.all([...touchedStates].map(state => d.stateBaseline(batch.baselineVersion, state)))
    const reasons = standardOrderProblems(states.flat(), edits, batch.stateOrders)
    if (reasons.length) return { ok: false, error: 'standard_change_unconfirmed', reasons }
  }
  const nextBatch: ReviewBatch = {
    ...batch, ...(state === 'submitted' ? { publishRequestedAt: null, publishRequestedBy: null } : {}), state, revision: revision + 1,
    approval: state === 'approved' ? { revision, by: a.uid, at: d.now() } : null,
  }
  const result = await d.store.commit(batchId, revision, { batch: nextBatch })
  return result === 'ok' ? { ok: true, value: nextBatch } : { ok: false, error: 'superseded_revision' }
}

export async function reorderState(
  d: ReviewDeps, actor: Actor,
  input: { batchId: string; state: string; batchRevision: number; order: string[]; standard?: StandardChange; promotion?: { plateId: string; templateFamily: string }; promotions?: { plateId: string; templateFamily: string }[] },
): Promise<Outcome<ReviewBatch>> {
  const batch = await d.store.getBatch(input.batchId)
  if (!batch) return { ok: false, error: 'not_found' }
  if (!canEdit(batch, actor)) return { ok: false, error: 'forbidden' }
  if (batch.revision !== input.batchRevision) return { ok: false, error: 'superseded_revision' }
  if (!editableStates.includes(batch.state)) return { ok: false, error: 'invalid_state' }
  const plates = await d.stateBaseline(batch.baselineVersion, input.state)
  const ids = new Set(plates.map(plate => plate.id))
  if (!plates.length || input.order.length !== ids.size || new Set(input.order).size !== ids.size || input.order.some(id => !ids.has(id))) {
    return { ok: false, error: 'invalid_state' }
  }
  const existingEdits = await d.store.listEdits(batch.id)
  const effectiveFields = new Map(existingEdits.map(edit => [edit.plateId, edit.fields]))
  const promotions = input.promotions ?? (input.promotion ? [input.promotion] : [])
  if (input.promotions && input.promotion || new Set(promotions.map(promotion => promotion.plateId)).size !== promotions.length) return { ok: false, error: 'invalid_state' }
  const changes = new Map<string, EditableFields>()
  let protectedPromotion = false
  const plateIds = [...batch.plateIds]
  for (const { plateId, templateFamily } of promotions) {
    const baseline = plates.find(plate => plate.id === plateId)
    const current = baseline && { ...baseline, ...effectiveFields.get(plateId) }
    if (!current || current.deleted || current.templateRole !== 'variant' || !templateFamily.trim() || templateFamily.length > limits.text) return { ok: false, error: 'invalid_state' }
    if (plates.some(plate => plate.id !== plateId && (changes.get(plate.id)?.templateFamily ?? effectiveFields.get(plate.id)?.templateFamily ?? plate.templateFamily) === templateFamily)) return { ok: false, error: 'invalid_state' }
    protectedPromotion ||= plateId === input.order[0] || !!current.isStandard
    changes.set(plateId, { templateRole: 'template', variantOfPlateId: null, templateFamily })
    if (!plateIds.includes(plateId)) plateIds.push(plateId)
  }
  if (plateIds.length > limits.plates) return { ok: false, error: 'invalid_state' }
  const previousFirst = (batch.stateOrders[input.state] ?? plates.map(plate => plate.id))[0]
  const preserveLegacy = previousFirst === input.order[0] && !input.standard && !protectedPromotion
  const edits = [...changes].map(([plateId, fields]) => {
    const baseline = plates.find(plate => plate.id === plateId)!
    const plate = { ...baseline, ...effectiveFields.get(plateId), ...fields }
    const delta = Object.fromEntries(editableKeys.filter(key => !sameEditableValue(key, baseline[key], plate[key])).map(key => [key, plate[key]]))
    return { plateId, fields: delta, baseRevision: plateRevision(baseline), resultRevision: plateRevision(plate), authorId: actor.uid, updatedAt: d.now() }
  })
  const combined = preserveLegacy
    ? { ok: true as const, value: { plateIds, edits, deleteEditsFor: [] } }
    : await standardEdits(d, actor, batch, plates, input.order, changes, input.standard)
  if (!combined.ok) return combined
  const next: ReviewBatch = {
    ...batch, plateIds: combined.value.plateIds, state: 'open', approval: null, revision: batch.revision + 1,
    stateOrders: { ...batch.stateOrders, [input.state]: [...input.order] },
    baselineOrders: { ...batch.baselineOrders, [input.state]: batch.baselineOrders?.[input.state] ?? plates.map(plate => plate.id) },
  }
  const result = await d.store.commit(batch.id, batch.revision, { batch: next, ...combined.value })
  if (result === 'ok' && batch.state !== 'open') await d.supersedeRun?.(batch)
  return result === 'ok' ? { ok: true, value: next } : { ok: false, error: 'superseded_revision' }
}
