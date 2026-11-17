import { orderedStatePlates } from '../catalog/order'
import type { Plate } from '../catalog/types'
import { editableKeys, limits } from './fields'
import { plateRevision } from './revision'
import type { Actor, EditableFields, Outcome, ProposedEdit, ReviewBatch, ReviewDeps, StandardChange } from './types'

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
  const standards = before.filter(plate => plate.isStandard && !plate.deleted)
  const confirmedFrom = standards.length ? standards.some(plate => plate.id === acknowledgement?.from) : acknowledgement?.from === null
  if ((standards.length !== 1 || standards[0].id !== first.id) && (!confirmedFrom || acknowledgement?.to !== first.id)) {
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
    const delta: EditableFields = Object.fromEntries(editableKeys.filter(key => JSON.stringify(current[key]) !== JSON.stringify(base[key])).map(key => [key, current[key]]))
    if (!Object.keys(delta).length) deleteEditsFor.push(base.id)
    else {
      plateIds.add(base.id)
      edits.push({ plateId: base.id, baseRevision: plateRevision(base), fields: delta, authorId: actor.uid, updatedAt: d.now(), resultRevision: plateRevision(current) })
    }
  }
  if (plateIds.size > limits.plates) return { ok: false, error: 'invalid_state' }
  return { ok: true, value: { edits, deleteEditsFor, plateIds: [...plateIds] } }
}

export function standardOrderProblems(plates: Plate[], edits: ProposedEdit[], orders: Record<string, string[]>): string[] {
  const fields = new Map(edits.map(edit => [edit.plateId, edit.fields]))
  const effective = plates.map(plate => ({ ...plate, ...fields.get(plate.id) }))
  const checkedOrders = { ...orders }
  for (const edit of edits) {
    if (!Object.hasOwn(edit.fields, 'isStandard')) continue
    const state = plates.find(plate => plate.id === edit.plateId)?.state
    if (state && !checkedOrders[state]) checkedOrders[state] = orderedStatePlates({ version: 0, plates }, state, { stateOrder: {}, stateProgress: {} }).map(plate => plate.id)
  }
  return Object.entries(checkedOrders).flatMap(([state, order]) => {
    const members = effective.filter(plate => plate.state === state && !plate.deleted)
    const standards = members.filter(plate => plate.isStandard)
    const first = members.find(plate => plate.id === order[0])
    return first?.templateRole === 'template' && standards.length === 1 && standards[0].id === first.id ? []
      : [state + ': use Standard plate issues to make ' + (first?.displayName ?? 'the first Template') + ' the Standard before submitting.']
  })
}
