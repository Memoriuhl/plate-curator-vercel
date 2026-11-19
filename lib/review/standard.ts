import { orderedStatePlates } from '../catalog/order'
import { familyRole } from '../catalog/families'
import type { Plate } from '../catalog/types'
import { batchPlateLimit, editableKeys } from './fields'
import { hasPipelineHistory, retainedPipelineChanges } from './pipeline-changes'
import { plateRevision } from './revision'
import type {
  Actor,
  EditableFields,
  Outcome,
  ProposedEdit,
  ReviewBatch,
  ReviewDeps,
  StandardChange,
} from './types'

/**
 * Build the coordinated plate edits needed to move a state's standard while preserving
 * existing draft history.
 */
export async function standardEdits(
  d: ReviewDeps,
  actor: Actor,
  batch: ReviewBatch,
  baseline: Plate[],
  order: string[],
  changes: Map<string, EditableFields>,
  acknowledgement?: StandardChange,
  options?: { existingEdits: ProposedEdit[]; preserveStandard: boolean }
): Promise<
  Outcome<{
    edits: ProposedEdit[]
    deleteEditsFor: string[]
    plateIds: string[]
  }>
> {
  const existing = options?.existingEdits ?? (await d.store.listEdits(batch.id))
  const byId = new Map(existing.map((edit) => [edit.plateId, edit]))
  const before = baseline.map((plate) => ({
    ...plate,
    ...byId.get(plate.id)?.fields,
  }))
  const effective = before.map((plate) => ({
    ...plate,
    ...changes.get(plate.id),
  }))
  const first = effective.find((plate) => plate.id === order[0])
  if (!first || first.deleted || familyRole(first) !== 'template')
    return { ok: false, error: 'standard_invalid_template' }
  const standards = before.filter((plate) => plate.isStandard && !plate.deleted)
  const confirmedFrom = standards.length
    ? standards.some((plate) => plate.id === acknowledgement?.from)
    : acknowledgement?.from === null
  if (
    !options?.preserveStandard &&
    (standards.length !== 1 || standards[0].id !== first.id) &&
    (!confirmedFrom || acknowledgement?.to !== first.id)
  ) {
    return { ok: false, error: 'standard_change_unconfirmed' }
  }
  const edits: ProposedEdit[] = []
  const deleteEditsFor: string[] = []
  const plateIds = new Set(batch.plateIds)
  for (let index = 0; index < baseline.length; index++) {
    const base = baseline[index]
    const current = effective[index]
    if (!current.deleted && base.deleted === undefined) delete current.deleted
    if (!options?.preserveStandard) {
      if (current.id === first.id) current.isStandard = true
      else if (current.isStandard) current.isStandard = false
    }
    if (
      JSON.stringify(current) === JSON.stringify(before[index]) &&
      !changes.has(current.id)
    )
      continue
    const delta: EditableFields = Object.fromEntries(
      editableKeys
        .filter(
          (key) => JSON.stringify(current[key]) !== JSON.stringify(base[key])
        )
        .map((key) => [key, current[key]])
    )
    const attribution = retainedPipelineChanges(byId.get(base.id), current)
    if (!Object.keys(delta).length && !hasPipelineHistory(attribution))
      deleteEditsFor.push(base.id)
    else {
      plateIds.add(base.id)
      edits.push({
        plateId: base.id,
        baseRevision: plateRevision(base),
        fields: delta,
        ...attribution,
        authorId: actor.uid,
        ...(actor.name ? { authorName: actor.name } : {}),
        updatedAt: d.now(),
        resultRevision: plateRevision(current),
      })
    }
  }
  if (plateIds.size > batchPlateLimit(batch))
    return { ok: false, error: 'invalid_state' }
  return { ok: true, value: { edits, deleteEditsFor, plateIds: [...plateIds] } }
}

/** Check affected state orders for a valid standard before the batch can advance. */
export function standardOrderProblems(
  plates: Plate[],
  edits: ProposedEdit[],
  orders: Record<string, string[]>
): string[] {
  const fields = new Map(edits.map((edit) => [edit.plateId, edit.fields]))
  const effective = plates.map((plate) => ({
    ...plate,
    ...fields.get(plate.id),
  }))
  const checkedOrders = { ...orders }
  for (const edit of edits) {
    if (!Object.hasOwn(edit.fields, 'isStandard')) continue
    const state = plates.find((plate) => plate.id === edit.plateId)?.state
    if (state && !checkedOrders[state])
      checkedOrders[state] = orderedStatePlates({ version: 0, plates }, state, {
        stateOrder: {},
        stateProgress: {},
      }).map((plate) => plate.id)
  }
  return Object.entries(checkedOrders).flatMap(([state, order]) => {
    const members = effective.filter(
      (plate) => plate.state === state && !plate.deleted
    )
    const standards = members.filter((plate) => plate.isStandard)
    const first = members.find((plate) => plate.id === order[0])
    return first &&
      familyRole(first) === 'template' &&
      standards.length === 1 &&
      standards[0].id === first.id
      ? []
      : [
          state +
            ': use Standard plate issues to make ' +
            (first?.displayName ?? 'the first Template') +
            ' the Standard before submitting.',
        ]
  })
}
