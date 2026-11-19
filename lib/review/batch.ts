import { standardEdits, standardOrderProblems } from './standard'
import { canEdit, editableStates } from './access'
import { familyRole } from '../catalog/families'
export { canEdit } from './access'
import type { Plate } from '../catalog/types'
import {
  batchPlateLimit,
  draftGroupingFields,
  editableKeys,
  limits,
} from './fields'
import {
  plateFieldConflicts,
  retryDraft,
  retryDraftRace,
  unchangedSince,
} from './preconditions'
import { draftCommitAttempts, draftRetryPause } from './retry'
import { sameEditableValue } from './story'
import { deletionPublishing, resolveConflicts } from './draft'
import {
  hasPipelineHistory,
  pipelineImageFields,
  retainedPipelineChanges,
  restoredPipelineChange,
} from './pipeline-changes'
import { plateRevision } from './revision'
import { plateEditVersion } from './edit-history'
import type {
  Actor,
  EditableFields,
  Outcome,
  ReviewBatch,
  ReviewDeps,
  StandardChange,
} from './types'

const groupRevertReason =
  'Reverting this field would leave a Template family or Variant link inconsistent. Edit the related grouping together.'
export const imageRevertReason =
  'The image or its source changed after this run. Review the current image and source together before making another change.'

/**
 * Overlay the current drafts on the state's baseline to ensure a proposed regroup
 * preserves valid families.
 */
async function regroupRemainsValid(
  d: ReviewDeps,
  batch: ReviewBatch,
  current: Plate,
  target: Plate
) {
  const [baseline, edits] = await Promise.all([
    d.stateBaseline(batch.baselineVersion, target.state, 'snapshot'),
    d.store.listEdits(batch.id),
  ])
  const byId = new Map(edits.map((edit) => [edit.plateId, edit.fields]))
  const state = new Map(
    baseline.map((plate) => [plate.id, { ...plate, ...byId.get(plate.id) }])
  )
  state.set(target.id, target)
  const affectedFamilies = new Set(
    [current.templateFamily, target.templateFamily].filter(Boolean)
  )
  return validRegroup(state, affectedFamilies, new Set([target.id]))
}

/**
 * Check that every affected family retains exactly one template and that changed plates
 * point to valid parents.
 */
export function validRegroup(
  state: ReadonlyMap<string, Plate>,
  affectedFamilies: ReadonlySet<string | undefined>,
  changedIds: ReadonlySet<string>
) {
  const counts = new Map<string, { plates: number; templates: number }>()
  for (const member of state.values()) {
    if (member.deleted) continue
    if (member.templateFamily && affectedFamilies.has(member.templateFamily)) {
      const count = counts.get(member.templateFamily) ?? {
        plates: 0,
        templates: 0,
      }
      count.plates += 1
      if (familyRole(member) === 'template') count.templates += 1
      counts.set(member.templateFamily, count)
    }
    if (
      member.variantOfPlateId &&
      (changedIds.has(member.id) || changedIds.has(member.variantOfPlateId))
    ) {
      const parent = state.get(member.variantOfPlateId)
      if (
        !parent ||
        parent.deleted ||
        familyRole(parent) !== 'template' ||
        parent.id === member.id ||
        parent.templateFamily !== member.templateFamily ||
        familyRole(member) !== 'variant'
      )
        return false
    }
  }
  return [...counts.values()].every(
    ({ plates, templates }) => !plates || templates === 1
  )
}

type FieldRevert = { field: keyof EditableFields; jobId: string }

/** Apply a curator's edit through the shared revision and batch access checks. */
export function proposeEdit(
  d: ReviewDeps,
  actor: Actor,
  input: {
    batchId: string
    plateId: string
    baseRevision: string
    editVersion?: number
    fields: EditableFields
    standard?: StandardChange
  }
) {
  return updatePlate(d, actor, input)
}

/** Restore a field's prior value while preserving the other results in the draft. */
export function revertPipelineField(
  d: ReviewDeps,
  actor: Actor,
  input: { batchId: string; plateId: string } & FieldRevert
) {
  return updatePlate(d, actor, { ...input, revert: input })
}

/**
 * Validate and commit a plate edit with revision checks so concurrent drafts and
 * pipeline results reconcile safely.
 */
async function updatePlate(
  d: ReviewDeps,
  a: Actor,
  i: { batchId: string; plateId: string } & (
    | {
        baseRevision: string
        editVersion?: number
        fields: EditableFields
        standard?: StandardChange
        revert?: never
      }
    | {
        revert: FieldRevert
        baseRevision?: never
        fields?: never
        standard?: never
      }
  )
): Promise<
  Outcome<{ batch: ReviewBatch; plate: Plate; editVersion?: number }>
> {
  for (let attempt = 0; attempt < draftCommitAttempts; attempt += 1) {
    await draftRetryPause(attempt)
    const batch = await d.store.getBatch(i.batchId)
    if (!batch) return { ok: false, error: 'not_found' }
    if (!canEdit(batch, a)) return { ok: false, error: 'forbidden' }
    if (!editableStates.includes(batch.state))
      return { ok: false, error: 'invalid_state' }
    const baseline = await d.baselineAtVersion(batch.baselineVersion, i.plateId)
    if (!baseline) return { ok: false, error: 'not_found' }
    const plateIds = batch.plateIds.includes(i.plateId)
      ? batch.plateIds
      : [...batch.plateIds, i.plateId]
    if (plateIds.length > batchPlateLimit(batch))
      return { ok: false, error: 'invalid_state' }
    const existing = await d.store.getEdit(i.batchId, i.plateId)
    const editVersion = plateEditVersion(batch, i.plateId)
    const current = { ...baseline, ...existing?.fields }
    let requested: EditableFields
    let revertedFields: (keyof EditableFields)[] = []
    if (i.revert) {
      const { field, jobId } = i.revert
      revertedFields =
        field === 'imageUrl' || field === 'sourceUrl'
          ? [...pipelineImageFields]
          : [field]
      const previous: [keyof EditableFields, unknown][] = []
      for (const key of revertedFields) {
        const change = existing?.pipelineChanges?.[key]
        if (
          !change ||
          change.jobId !== jobId ||
          !sameEditableValue(key, change.value, current[key])
        )
          return {
            ok: false,
            error: 'superseded_revision',
            ...(revertedFields.length > 1
              ? { reasons: [imageRevertReason] }
              : {}),
          }
        previous.push([
          key,
          Object.hasOwn(change, 'previous') ? change.previous : baseline[key],
        ])
      }
      requested = Object.fromEntries(previous)
    } else {
      if (
        plateRevision(current) !== i.baseRevision ||
        (i.editVersion !== undefined && i.editVersion !== editVersion)
      ) {
        const conflicts = await plateFieldConflicts(
          d,
          batch,
          baseline,
          existing,
          i.baseRevision,
          i.fields,
          i.editVersion !== undefined && i.editVersion < editVersion
            ? i.editVersion
            : undefined
        )
        return {
          ok: false,
          error: 'stale_plate',
          current,
          ...(batch.kind === 'shared-draft' && {
            currentEditVersion: editVersion,
          }),
          ...(conflicts && { conflicts }),
        }
      }
      requested = i.fields
    }
    const changes = Object.fromEntries(
      editableKeys
        .filter(
          (key) =>
            (revertedFields.includes(key) || requested[key] !== undefined) &&
            !sameEditableValue(key, current[key], requested[key])
        )
        .map((key) => [key, requested[key]])
    )
    const plate = { ...current, ...changes }
    for (const field of revertedFields)
      if (plate[field] === undefined) delete plate[field]
    if (
      i.revert &&
      draftGroupingFields.some((field) => Object.hasOwn(changes, field)) &&
      !(await regroupRemainsValid(d, batch, current, plate))
    )
      return { ok: false, error: 'invalid_state', reasons: [groupRevertReason] }
    if (
      current.isStandard &&
      ((Object.hasOwn(changes, 'isStandard') && !plate.isStandard) ||
        (Object.hasOwn(changes, 'templateRole') &&
          familyRole(plate) !== 'template'))
    )
      return { ok: false, error: 'standard_required' }
    let deletionPublishFence: number | undefined
    if (existing?.fields.deleted && !plate.deleted) {
      deletionPublishFence = await d.store.deletionPublishFence?.(batch.id)
      const publishing = await deletionPublishing(d, batch, i.plateId)
      if (publishing)
        return { ok: false, error: 'invalid_state', reasons: [publishing] }
    }
    if (!plate.deleted && (plate.variantOfPlateId || plate.templateFamily)) {
      const edits = await d.store.listEdits(batch.id)
      const deleted = edits.filter(
        (edit) => edit.plateId !== plate.id && edit.fields.deleted
      )
      if (deleted.some((edit) => edit.plateId === plate.variantOfPlateId))
        return { ok: false, error: 'invalid_state' }
      if (plate.templateFamily) {
        const parents = await Promise.all(
          deleted.map(async (edit) => ({
            ...(await d.baselineAtVersion(batch.baselineVersion, edit.plateId)),
            ...edit.fields,
          }))
        )
        if (
          parents.some(
            (parent) =>
              familyRole(parent) === 'template' &&
              parent.templateFamily === plate.templateFamily
          )
        )
          return { ok: false, error: 'invalid_state' }
      }
    }
    if (plate.deleted) {
      if (plate.isStandard) return { ok: false, error: 'invalid_state' }
      const [plates, edits] = await Promise.all([
        d.stateBaseline(batch.baselineVersion, plate.state),
        d.store.listEdits(batch.id),
      ])
      const fieldsById = new Map(
        edits.map((edit) => [edit.plateId, edit.fields])
      )
      const hasLinkedPlates = plates.some((baseline) => {
        const member = { ...baseline, ...fieldsById.get(baseline.id) }
        return (
          member.id !== plate.id &&
          !member.deleted &&
          (member.variantOfPlateId === plate.id ||
            (familyRole(plate) === 'template' &&
              familyRole(member) !== 'template' &&
              !!plate.templateFamily &&
              member.templateFamily === plate.templateFamily))
        )
      })
      if (hasLinkedPlates) return { ok: false, error: 'invalid_state' }
    }
    if (!plate.deleted && baseline.deleted === undefined) delete plate.deleted
    const fields: EditableFields = Object.fromEntries(
      editableKeys
        .filter((key) => !sameEditableValue(key, baseline[key], plate[key]))
        .map((key) => [key, plate[key]])
    )
    const changedAt = d.now()
    const nextBatch: ReviewBatch = resolveConflicts(
      {
        ...batch,
        lastChangedAt: changedAt,
        plateIds,
        state: 'open',
        revision: batch.revision + 1,
        approval: null,
      },
      { plateId: i.plateId, fields: Object.keys(changes) }
    )
    const attribution = retainedPipelineChanges(existing, plate)
    for (const field of revertedFields) {
      const change = existing?.pipelineChanges?.[field]
      const prior = restoredPipelineChange(field, change, plate[field])
      if (prior) {
        attribution.pipelineChanges ??= {}
        attribution.pipelineChanges[field] = prior
      } else if (attribution.pipelineChanges) {
        delete attribution.pipelineChanges[field]
      }
    }
    const edit = {
      plateId: i.plateId,
      baseRevision: plateRevision(baseline),
      fields,
      ...attribution,
      authorId: a.uid,
      ...(a.name ? { authorName: a.name } : {}),
      updatedAt: changedAt,
      resultRevision: plateRevision(plate),
    }
    let combined: Awaited<ReturnType<typeof standardEdits>> | undefined
    const firstId = batch.stateOrders[plate.state]?.[0]
    const affectsStandard =
      (current.isStandard || plate.id === firstId) &&
      ['isStandard', 'templateRole', 'deleted', 'variantOfPlateId'].some(
        (key) => Object.hasOwn(requested, key)
      )
    if (requested.isStandard === true || (firstId && affectsStandard)) {
      const baselinePlates = await d.stateBaseline(
        batch.baselineVersion,
        plate.state
      )
      let order =
        batch.stateOrders[plate.state] ??
        baselinePlates.map((member) => member.id)
      if (requested.isStandard === true) {
        if (plate.deleted || familyRole(plate) !== 'template')
          return { ok: false, error: 'standard_invalid_template' }
        const existingEdits = await d.store.listEdits(batch.id)
        const effectiveFields = new Map(
          existingEdits.map((edit) => [edit.plateId, edit.fields])
        )
        const familyIds = new Set(
          baselinePlates
            .filter((member) => {
              const effective = { ...member, ...effectiveFields.get(member.id) }
              return (
                member.id === plate.id ||
                effective.variantOfPlateId === plate.id ||
                (!!plate.templateFamily &&
                  effective.templateFamily === plate.templateFamily)
              )
            })
            .map((member) => member.id)
        )
        order = [
          plate.id,
          ...order.filter((id) => id !== plate.id && familyIds.has(id)),
          ...order.filter((id) => !familyIds.has(id)),
        ]
      }
      combined = await standardEdits(
        d,
        a,
        batch,
        baselinePlates,
        order,
        new Map([[plate.id, changes]]),
        i.standard
      )
      if (!combined.ok) return combined
      if (i.revert && hasPipelineHistory(edit)) {
        const selected = combined.value.edits.find(
          (candidate) => candidate.plateId === i.plateId
        )
        if (selected) Object.assign(selected, attribution)
        else {
          combined.value.deleteEditsFor = combined.value.deleteEditsFor.filter(
            (id) => id !== i.plateId
          )
          combined.value.edits.push(edit)
        }
      }
      nextBatch.plateIds = combined.value.plateIds
      nextBatch.stateOrders = { ...batch.stateOrders, [plate.state]: order }
      if (order !== batch.stateOrders[plate.state])
        nextBatch.stateOrderChangedAt = {
          ...batch.stateOrderChangedAt,
          [plate.state]: changedAt,
        }
      nextBatch.baselineOrders = {
        ...batch.baselineOrders,
        [plate.state]:
          batch.baselineOrders?.[plate.state] ??
          baselinePlates.map((member) => member.id),
      }
    }
    const result = await d.store.commit(i.batchId, batch.revision, {
      batch: nextBatch,
      by: a,
      deletionPublishFence,
      ...(combined?.ok
        ? combined.value
        : Object.keys(fields).length || hasPipelineHistory(edit)
          ? { edit }
          : { deleteEditFor: i.plateId }),
    })
    if (result === 'ok') {
      const touched =
        !combined?.ok ||
        combined.value.edits.some((edit) => edit.plateId === i.plateId) ||
        combined.value.deleteEditsFor.includes(i.plateId)
      return {
        ok: true,
        value: {
          batch: nextBatch,
          plate,
          ...(batch.kind === 'shared-draft' && {
            editVersion: touched ? nextBatch.revision : editVersion,
          }),
        },
      }
    }
  }
  return { ok: false, error: 'superseded_revision' }
}

/**
 * Collect state order and standard-plate problems that must be resolved before approval.
 */
export async function reviewApprovalProblems(
  d: ReviewDeps,
  batch: ReviewBatch
): Promise<string[]> {
  const edits = await d.store.listEdits(batch.id)
  const standardPlates = await Promise.all(
    edits
      .filter(
        ({ fields }) =>
          Object.hasOwn(fields, 'isStandard') ||
          Object.hasOwn(fields, 'templateRole') ||
          fields.deleted
      )
      .map((edit) => d.baselineAtVersion(batch.baselineVersion, edit.plateId))
  )
  const touchedStates = new Set([
    ...Object.keys(batch.stateOrders),
    ...standardPlates.flatMap((plate) => (plate ? [plate.state] : [])),
  ])
  const states = await Promise.all(
    [...touchedStates].map((state) =>
      d.stateBaseline(batch.baselineVersion, state)
    )
  )
  return standardOrderProblems(states.flat(), edits, batch.stateOrders, {
    ...Object.fromEntries(
      states.filter((plates) => plates.length).map((plates) => [
        plates[0].state,
        plates.map((plate) => plate.id),
      ])
    ),
    ...batch.baselineOrders,
  })
}

/**
 * Save a state's manual ordering and any standard-plate changes together at the expected
 * batch revision.
 */
type ReorderInput = {
  batchId: string
  state: string
  /** Draft revision the curator saw; only a later change to this state's order or to a promoted plate blocks the save. */
  batchRevision: number
  order: string[]
  standard?: StandardChange
  promotion?: { plateId: string; templateFamily: string }
  promotions?: { plateId: string; templateFamily: string }[]
}

export function reorderState(
  d: ReviewDeps,
  actor: Actor,
  input: ReorderInput
): Promise<Outcome<ReviewBatch>> {
  return retryDraftRace(() => reorderStateOnce(d, actor, input))
}

async function reorderStateOnce(
  d: ReviewDeps,
  actor: Actor,
  input: ReorderInput
): Promise<Outcome<ReviewBatch> | typeof retryDraft> {
  const batch = await d.store.getBatch(input.batchId)
  if (!batch) return { ok: false, error: 'not_found' }
  if (!canEdit(batch, actor)) return { ok: false, error: 'forbidden' }
  if (
    !(await unchangedSince(d, batch, input.batchRevision, {
      orderStates: [input.state],
      plateIds: [
        ...(input.promotions ?? []).map((promotion) => promotion.plateId),
        ...(input.promotion ? [input.promotion.plateId] : []),
      ],
    }))
  )
    return { ok: false, error: 'superseded_revision' }
  if (!editableStates.includes(batch.state))
    return { ok: false, error: 'invalid_state' }
  const plates = await d.stateBaseline(batch.baselineVersion, input.state)
  const ids = new Set(plates.map((plate) => plate.id))
  if (
    !plates.length ||
    input.order.length !== ids.size ||
    new Set(input.order).size !== ids.size ||
    input.order.some((id) => !ids.has(id))
  ) {
    return { ok: false, error: 'invalid_state' }
  }
  const existingEdits = await d.store.listEdits(batch.id)
  const editsById = new Map(existingEdits.map((edit) => [edit.plateId, edit]))
  const promotions =
    input.promotions ?? (input.promotion ? [input.promotion] : [])
  if (
    (input.promotions && input.promotion) ||
    new Set(promotions.map((promotion) => promotion.plateId)).size !==
      promotions.length
  )
    return { ok: false, error: 'invalid_state' }
  const changes = new Map<string, EditableFields>()
  let protectedPromotion = false
  const plateIds = [...batch.plateIds]
  for (const { plateId, templateFamily } of promotions) {
    const baseline = plates.find((plate) => plate.id === plateId)
    const current = baseline && {
      ...baseline,
      ...editsById.get(plateId)?.fields,
    }
    if (
      !current ||
      current.deleted ||
      familyRole(current) !== 'variant' ||
      !templateFamily.trim() ||
      templateFamily.length > limits.text
    )
      return { ok: false, error: 'invalid_state' }
    if (
      plates.some(
        (plate) =>
          plate.id !== plateId &&
          (changes.get(plate.id)?.templateFamily ??
            editsById.get(plate.id)?.fields.templateFamily ??
            plate.templateFamily) === templateFamily
      )
    )
      return { ok: false, error: 'invalid_state' }
    protectedPromotion ||= plateId === input.order[0] || !!current.isStandard
    changes.set(plateId, {
      templateRole: 'template',
      variantOfPlateId: null,
      templateFamily,
    })
    if (!plateIds.includes(plateId)) plateIds.push(plateId)
  }
  if (plateIds.length > batchPlateLimit(batch))
    return { ok: false, error: 'invalid_state' }
  const previousFirst = (batch.stateOrders[input.state] ??
    plates.map((plate) => plate.id))[0]
  const preserveLegacy =
    previousFirst === input.order[0] && !input.standard && !protectedPromotion
  const edits = [...changes].map(([plateId, fields]) => {
    const baseline = plates.find((plate) => plate.id === plateId)!
    const plate = { ...baseline, ...editsById.get(plateId)?.fields, ...fields }
    const delta = Object.fromEntries(
      editableKeys
        .filter((key) => !sameEditableValue(key, baseline[key], plate[key]))
        .map((key) => [key, plate[key]])
    )
    return {
      plateId,
      fields: delta,
      ...retainedPipelineChanges(editsById.get(plateId), plate),
      baseRevision: plateRevision(baseline),
      resultRevision: plateRevision(plate),
      authorId: actor.uid,
      ...(actor.name ? { authorName: actor.name } : {}),
      updatedAt: d.now(),
    }
  })
  const combined = preserveLegacy
    ? { ok: true as const, value: { plateIds, edits, deleteEditsFor: [] } }
    : await standardEdits(
        d,
        actor,
        batch,
        plates,
        input.order,
        changes,
        input.standard
      )
  if (!combined.ok) return combined
  const changedAt = d.now()
  const next: ReviewBatch = resolveConflicts(
    {
      ...batch,
      lastChangedAt: changedAt,
      plateIds: combined.value.plateIds,
      state: 'open',
      approval: null,
      revision: batch.revision + 1,
      stateOrders: { ...batch.stateOrders, [input.state]: [...input.order] },
      stateOrderChangedAt: {
        ...batch.stateOrderChangedAt,
        [input.state]: changedAt,
      },
      baselineOrders: {
        ...batch.baselineOrders,
        [input.state]:
          batch.baselineOrders?.[input.state] ??
          plates.map((plate) => plate.id),
      },
    },
    { state: input.state }
  )
  const result = await d.store.commit(batch.id, batch.revision, {
    batch: next,
    by: actor,
    ...combined.value,
  })
  if (result === 'ok') return { ok: true, value: next }
  return result === 'revision_mismatch'
    ? retryDraft
    : { ok: false, error: result }
}
