import { orderedStatePlates } from '../../catalog/order'
import { familyRole } from '../../catalog/families'
import { checkStandardOrder } from '../../catalog/standard-position'
import type { Plate } from '../../catalog/types'
import { batchPlateLimit, editableKeys } from '../fields'
import {
  hasPipelineHistory,
  retainedPipelineChanges,
} from '../pipeline-changes'
import { plateRevision } from '../revision'
import type {
  Actor,
  EditableFields,
  Outcome,
  ProposedEdit,
  ReviewBatch,
  ReviewDeps,
  StandardChange,
} from '../types'

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
  options?: {
    existingEdits: ProposedEdit[]
    preserveStandard: boolean
    firstId: string | undefined
  }
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
  const firstId = options ? options.firstId : order[0]
  const first = effective.find((plate) => plate.id === firstId)
  if (
    !options?.preserveStandard &&
    (!first || first.deleted || familyRole(first) !== 'template')
  )
    return { ok: false, error: 'standard_invalid_template' }
  const standards = before.filter((plate) => plate.isStandard && !plate.deleted)
  const confirmedFrom = standards.length
    ? standards.some((plate) => plate.id === acknowledgement?.from)
    : acknowledgement?.from === null
  if (
    !options?.preserveStandard &&
    (options || standards.length !== 1 || standards[0].id !== firstId) &&
    (!confirmedFrom || acknowledgement?.to !== firstId)
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
      if (current.id === firstId) current.isStandard = true
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
  orders: Record<string, string[]>,
  baselineOrders: Record<string, string[]> = {}
): string[] {
  const fields = new Map(edits.map((edit) => [edit.plateId, edit.fields]))
  const byState = Map.groupBy(plates, (plate) => plate.state)
  const checkedStates = new Set([
    ...Object.keys(orders),
    ...plates
      .filter((plate) => {
        const edit = fields.get(plate.id)
        return (
          edit &&
          (Object.hasOwn(edit, 'isStandard') ||
            (plate.isStandard &&
              (Object.hasOwn(edit, 'templateRole') || edit.deleted)))
        )
      })
      .map((plate) => plate.state),
  ])
  return [...checkedStates].flatMap((state) => {
    const before = byState.get(state) ?? []
    const after = before.map((plate) => ({ ...plate, ...fields.get(plate.id) }))
    const standard = checkStandardOrder(
      orderedStatePlates({ version: 0, plates: before }, state, {
        stateOrder: baselineOrders,
        stateProgress: {},
      }),
      orderedStatePlates({ version: 0, plates: after }, state, {
        stateOrder: orders[state] ? orders : baselineOrders,
        stateProgress: {},
      })
    )
    return standard.valid
      ? []
      : [
          state +
            ': use Standard plate issues to make ' +
            (after.find((plate) => plate.id === standard.first)?.displayName ??
              'the first Template') +
            ' the Standard before submitting.',
        ]
  })
}
