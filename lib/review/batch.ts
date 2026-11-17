import { canEdit, editableStates } from './access'
export { canEdit } from './access'
import type { Plate } from '../catalog/types'
import { limits } from './fields'
import { plateRevision } from './revision'
import type { Actor, EditableFields, Outcome, ReviewBatch, ReviewDeps } from './types'

const editableKeys = ['tags', 'templateFamily', 'templateRole', 'variantOfPlateId', 'isStandard', 'description', 'deleted'] as const

export async function proposeEdit(
  d: ReviewDeps,
  a: Actor,
  i: { batchId: string; plateId: string; baseRevision: string; fields: EditableFields },
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
      .filter(key => i.fields[key] !== undefined)
      .map(key => [key, i.fields[key]]))
    const plate = { ...current, ...changes }
    if (plate.deleted) {
      if (plate.isStandard) return { ok: false, error: 'invalid_state' }
      if (plate.templateRole === 'template') {
        const [plates, edits] = await Promise.all([
          d.stateBaseline(batch.baselineVersion, plate.state),
          d.store.listEdits(batch.id),
        ])
        const fieldsById = new Map(edits.map(edit => [edit.plateId, edit.fields]))
        const hasVariants = plates.some(baseline => {
          const member = { ...baseline, ...fieldsById.get(baseline.id) }
          return member.id !== plate.id && !member.deleted && member.templateRole === 'variant'
            && (member.variantOfPlateId === plate.id || !!plate.templateFamily && member.templateFamily === plate.templateFamily)
        })
        if (hasVariants) return { ok: false, error: 'invalid_state' }
      }
    }
    if (!plate.deleted && baseline.deleted === undefined) delete plate.deleted
    const fields: EditableFields = Object.fromEntries(editableKeys
      .filter(key => JSON.stringify(plate[key]) !== JSON.stringify(baseline[key]))
      .map(key => [key, plate[key]]))
    const nextBatch: ReviewBatch = { ...batch, plateIds, state: 'open', revision: batch.revision + 1, approval: null }
    const edit = {
      plateId: i.plateId, baseRevision: plateRevision(baseline), fields,
      authorId: a.uid, updatedAt: d.now(), resultRevision: plateRevision(plate),
    }
    const result = await d.store.commit(i.batchId, batch.revision, {
      batch: nextBatch,
      ...(Object.keys(fields).length === 0 ? { deleteEditFor: i.plateId } : { edit }),
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
  const nextBatch: ReviewBatch = {
    ...batch, ...(state === 'submitted' ? { publishRequestedAt: null, publishRequestedBy: null } : {}), state, revision: revision + 1,
    approval: state === 'approved' ? { revision, by: a.uid, at: d.now() } : null,
  }
  const result = await d.store.commit(batchId, revision, { batch: nextBatch })
  return result === 'ok' ? { ok: true, value: nextBatch } : { ok: false, error: 'superseded_revision' }
}

export async function reorderState(
  d: ReviewDeps, actor: Actor,
  input: { batchId: string; state: string; batchRevision: number; order: string[]; promotion?: { plateId: string; templateFamily: string } },
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
  let edit
  let plateIds = batch.plateIds
  if (input.promotion) {
    const { plateId, templateFamily } = input.promotion
    const baseline = await d.baselineAtVersion(batch.baselineVersion, plateId)
    if (!baseline || !ids.has(plateId) || baseline.state !== input.state) return { ok: false, error: 'invalid_state' }
    const existing = await d.store.getEdit(batch.id, plateId)
    const current = { ...baseline, ...existing?.fields }
    if (current.templateRole !== 'variant' || !templateFamily.trim() || templateFamily.length > limits.text) return { ok: false, error: 'invalid_state' }
    const edits = await d.store.listEdits(batch.id)
    if (plates.some(plate => plate.id !== plateId && (edits.find(entry => entry.plateId === plate.id)?.fields.templateFamily ?? plate.templateFamily) === templateFamily)) return { ok: false, error: 'invalid_state' }
    plateIds = plateIds.includes(plateId) ? plateIds : [...plateIds, plateId]
    if (plateIds.length > limits.plates) return { ok: false, error: 'invalid_state' }
    const plate = { ...current, templateRole: 'template' as const, variantOfPlateId: null, templateFamily }
    const fields: EditableFields = Object.fromEntries(editableKeys
      .filter(key => JSON.stringify(plate[key]) !== JSON.stringify(baseline[key]))
      .map(key => [key, plate[key]]))
    edit = { plateId, baseRevision: plateRevision(baseline), fields, authorId: actor.uid, updatedAt: d.now(), resultRevision: plateRevision(plate) }
  }
  const next: ReviewBatch = {
    ...batch, plateIds, state: 'open', approval: null, revision: batch.revision + 1,
    stateOrders: { ...batch.stateOrders, [input.state]: [...input.order] },
    baselineOrders: { ...batch.baselineOrders, [input.state]: batch.baselineOrders?.[input.state] ?? plates.map(plate => plate.id) },
  }
  const result = await d.store.commit(batch.id, batch.revision, { batch: next, ...(edit ? { edit } : {}) })
  if (result === 'ok' && batch.state !== 'open') await d.supersedeRun?.(batch)
  return result === 'ok' ? { ok: true, value: next } : { ok: false, error: 'superseded_revision' }
}
