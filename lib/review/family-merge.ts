import { familyRole, groupFamilies } from '../catalog/families'
import { canEdit, editableStates } from './access'
import { validRegroup } from './batch'
import { batchPlateLimit, editableKeys, limits } from './fields'
import { retryDraft, retryDraftRace, unchangedSince } from './preconditions'
import { planFamilyMerge, type FamilyMergeResult } from './family-merge-plan'
import { hasPipelineHistory, retainedPipelineChanges } from './pipeline-changes'
import { plateRevision } from './revision'
import { sameEditableValue } from './story'
import type { Actor, EditableFields, Outcome, ReviewDeps } from './types'

export type FamilyMerge = {
  destination: { id: string; revision: string }
  members: { id: string; revision: string }[]
  catalogVersion?: number
}

/**
 * Apply a family merge in one batch commit after checking scope, permissions and the
 * current plate revisions.
 */
export function mergeFamily(
  d: ReviewDeps,
  actor: Actor,
  input: FamilyMerge & { batchId: string; batchRevision: number }
): Promise<Outcome<FamilyMergeResult>> {
  return retryDraftRace(() => mergeFamilyOnce(d, actor, input))
}

async function mergeFamilyOnce(
  d: ReviewDeps,
  actor: Actor,
  input: FamilyMerge & { batchId: string; batchRevision: number }
): Promise<Outcome<FamilyMergeResult> | typeof retryDraft> {
  const detail = await d.store.readBatch(input.batchId)
  if (!detail) return { ok: false, error: 'not_found' }
  const { batch, edits } = detail
  if (!canEdit(batch, actor)) return { ok: false, error: 'forbidden' }
  if (
    !(await unchangedSince(d, batch, input.batchRevision, {
      plateIds: [input.destination.id, ...input.members.map(({ id }) => id)],
    }))
  )
    return { ok: false, error: 'superseded_revision' }
  if (!editableStates.includes(batch.state))
    return { ok: false, error: 'invalid_state' }
  if (
    input.catalogVersion !== undefined &&
    input.catalogVersion !== batch.baselineVersion
  ) {
    return {
      ok: false,
      error: 'invalid_state',
      reasons: [
        'Use a Batch based on the displayed catalog version to move plates.',
      ],
    }
  }
  const state = input.destination.id.split('.')[0]
  const baseline = await d.stateBaseline(
    batch.baselineVersion,
    state,
    'snapshot'
  )
  const editsById = new Map(edits.map((edit) => [edit.plateId, edit]))
  const effective = new Map(
    baseline.map((plate) => [
      plate.id,
      { ...plate, ...editsById.get(plate.id)?.fields },
    ])
  )
  const destination = effective.get(input.destination.id)
  if (
    !destination ||
    destination.deleted ||
    familyRole(destination) !== 'template'
  ) {
    return {
      ok: false,
      error: 'invalid_state',
      reasons: ['Drop onto an active Template family.'],
    }
  }
  const selected = new Set(input.members.map((member) => member.id))
  if (selected.size !== input.members.length || selected.size > limits.plates)
    return { ok: false, error: 'invalid_state' }
  for (const { id, revision } of [input.destination, ...input.members]) {
    const current = effective.get(id)
    if (!current || plateRevision(current) !== revision)
      return { ok: false, error: 'superseded_revision' }
  }

  const families = groupFamilies(
    [...effective.values()].map((plate) => ({
      ...plate,
      templateRole: familyRole(plate),
    }))
  )
  const family = families.find(
    (family) => family.template.id === destination.id
  )!
  const { result, changes } = planFamilyMerge(
    families,
    family,
    [...selected],
    batch.stateOrders[state]?.[0]
  )
  if (!changes.size) return { ok: true, value: result }

  const modified = new Map(effective)
  const affectedFamilies = new Set([
    destination.templateFamily || destination.id,
  ])
  for (const [id, fields] of changes) {
    const current = effective.get(id)!
    if (current.templateFamily) affectedFamilies.add(current.templateFamily)
    modified.set(id, { ...current, ...fields })
  }
  if (!validRegroup(modified, affectedFamilies, new Set(changes.keys()))) {
    return {
      ok: false,
      error: 'invalid_state',
      reasons: ['The move would leave an inconsistent family or Variant link.'],
    }
  }
  const plateIds = [...new Set([...batch.plateIds, ...changes.keys()])]
  if (plateIds.length > batchPlateLimit(batch))
    return {
      ok: false,
      error: 'invalid_state',
      reasons: ['This move would exceed the Batch plate limit.'],
    }

  const changedAt = d.now()
  const deleteEditsFor: string[] = []
  const nextEdits = baseline.flatMap((base) => {
    if (!changes.has(base.id)) return []
    const plate = modified.get(base.id)!
    const delta: EditableFields = Object.fromEntries(
      editableKeys
        .filter((key) => !sameEditableValue(key, base[key], plate[key]))
        .map((key) => [key, plate[key]])
    )
    const attribution = retainedPipelineChanges(editsById.get(base.id), plate)
    if (!Object.keys(delta).length && !hasPipelineHistory(attribution)) {
      deleteEditsFor.push(base.id)
      return []
    }
    return [
      {
        plateId: base.id,
        fields: delta,
        ...attribution,
        baseRevision: plateRevision(base),
        resultRevision: plateRevision(plate),
        authorId: actor.uid,
        updatedAt: changedAt,
      },
    ]
  })
  const next = {
    ...batch,
    lastChangedAt: changedAt,
    plateIds,
    state: 'open' as const,
    approval: null,
    revision: batch.revision + 1,
  }
  const saved = await d.store.commit(batch.id, batch.revision, {
    batch: next,
    by: actor,
    edits: nextEdits,
    deleteEditsFor,
  })
  if (saved === 'revision_mismatch') return retryDraft
  if (saved !== 'ok') return { ok: false, error: saved }
  const moving = new Set(result.moved)
  result.moved = baseline
    .filter((plate) => moving.has(plate.id))
    .map((plate) => plate.id)
  return { ok: true, value: result }
}
