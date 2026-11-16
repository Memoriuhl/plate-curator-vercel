import type { Plate } from '../catalog/types'
import { limits } from './fields'
import { plateRevision } from './revision'
import type { Actor, EditableFields, Outcome, ReviewBatch, ReviewDeps } from './types'

const editableKeys = ['tags', 'templateFamily', 'templateRole', 'variantOfPlateId', 'isStandard', 'description'] as const

export function canEdit(batch: ReviewBatch, actor: Actor): boolean {
  return batch.createdBy === actor.uid || actor.role === 'owner'
}

export async function proposeEdit(
  d: ReviewDeps,
  a: Actor,
  i: { batchId: string; plateId: string; baseRevision: string; fields: EditableFields },
): Promise<Outcome<{ batch: ReviewBatch; plate: Plate }>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const batch = await d.store.getBatch(i.batchId)
    if (!batch) return { ok: false, error: 'not_found' }
    if (!canEdit(batch, a)) return { ok: false, error: 'forbidden' }
    if (!['open', 'submitted', 'approved'].includes(batch.state)) return { ok: false, error: 'invalid_state' }
    const baseline = await d.baseline(i.plateId)
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
    if (result === 'ok') return { ok: true, value: { batch: nextBatch, plate } }
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
    ...batch, state, revision: revision + 1,
    approval: state === 'approved' ? { revision, by: a.uid, at: d.now() } : null,
  }
  const result = await d.store.commit(batchId, revision, { batch: nextBatch })
  return result === 'ok' ? { ok: true, value: nextBatch } : { ok: false, error: 'superseded_revision' }
}
