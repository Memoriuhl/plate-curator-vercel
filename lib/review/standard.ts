import type { Plate } from '../catalog/types'
import { limits } from './fields'
import { plateRevision } from './revision'
import type { Actor, EditableFields, Outcome, ProposedEdit, ReviewBatch, ReviewDeps, StandardChange } from './types'

const keys = ['tags', 'templateFamily', 'templateRole', 'variantOfPlateId', 'isStandard', 'description', 'deleted'] as const

export async function standardEdits(
  d: ReviewDeps, actor: Actor, batch: ReviewBatch, baseline: Plate[], order: string[],
  changes: Map<string, EditableFields>, acknowledgement?: StandardChange,
): Promise<Outcome<{ edits: ProposedEdit[]; deleteEditsFor: string[]; plateIds: string[] }>> {
  const existing = await d.store.listEdits(batch.id)
  const fields = new Map(existing.map(edit => [edit.plateId, edit.fields]))
  const before = baseline.map(plate => ({ ...plate, ...fields.get(plate.id) }))
  const effective = before.map(plate => ({ ...plate, ...changes.get(plate.id) }))
  const first = effective.find(plate => plate.id === order[0])
  if (!first || first.deleted || first.templateRole !== 'template') return { ok: false, error: 'standard_invalid_template' }
  const from = before.find(plate => plate.isStandard && !plate.deleted)?.id ?? null
  if (from !== first.id && (acknowledgement?.from !== from || acknowledgement?.to !== first.id)) {
    return { ok: false, error: 'standard_change_unconfirmed' }
  }
  const edits: ProposedEdit[] = []
  const deleteEditsFor: string[] = []
  const plateIds = new Set(batch.plateIds)
  for (let index = 0; index < baseline.length; index++) {
    const base = baseline[index]
    const current = effective[index]
    if (!current.deleted && base.deleted === undefined) delete current.deleted
    if (current.id === first.id) current.isStandard = true
    else if (current.isStandard) current.isStandard = false
    if (JSON.stringify(current) === JSON.stringify(before[index]) && !changes.has(current.id)) continue
    const delta: EditableFields = Object.fromEntries(keys.filter(key => JSON.stringify(current[key]) !== JSON.stringify(base[key])).map(key => [key, current[key]]))
    if (!Object.keys(delta).length) deleteEditsFor.push(base.id)
    else {
      plateIds.add(base.id)
      edits.push({ plateId: base.id, baseRevision: plateRevision(base), fields: delta, authorId: actor.uid, updatedAt: d.now(), resultRevision: plateRevision(current) })
    }
  }
  if (plateIds.size > limits.plates) return { ok: false, error: 'invalid_state' }
  return { ok: true, value: { edits, deleteEditsFor, plateIds: [...plateIds] } }
}
