import { familyRole, groupFamilies } from '../catalog/families'
import { canEdit, editableStates } from './access'
import { validRegroup } from './batch'
import { orderOnto, resolveConflicts, sameList } from './draft'
import { planFamilyMerge, type FamilyMergeResult } from './family-merge-plan'
import { retryDraft, retryDraftRace } from './preconditions'
import { standardEdits } from './standard'
import type { StateMove } from './state-move'
import type {
  Actor,
  EditableFields,
  Outcome,
  ReviewBatch,
  ReviewDeps,
  StandardChange,
} from './types'

type Input = {
  batchId: string
  state: string
  moves: StateMove[]
  standard?: StandardChange
}

type Result = { batch: ReviewBatch; merge?: FamilyMergeResult }

export function moveState(
  d: ReviewDeps,
  actor: Actor,
  input: Input
): Promise<Outcome<Result>> {
  return retryDraftRace(() => moveStateOnce(d, actor, input))
}

async function moveStateOnce(
  d: ReviewDeps,
  actor: Actor,
  input: Input
): Promise<Outcome<Result> | typeof retryDraft> {
  const { batchId, state, moves, standard } = input
  const detail = await d.store.readBatch(batchId)
  if (!detail) return { ok: false, error: 'not_found' }
  const { batch, edits } = detail
  if (!canEdit(batch, actor)) return { ok: false, error: 'forbidden' }
  if (!editableStates.includes(batch.state))
    return { ok: false, error: 'invalid_state' }

  const baseline = (await d.stateBaseline(batch.baselineVersion, state)).filter(
    (plate) => plate.state === state
  )
  const baselineOrder = baseline.map(({ id }) => id)
  const previousOrder = orderOnto(
    batch.stateOrders[state] ?? baselineOrder,
    baselineOrder
  )
  const editsById = new Map(edits.map((edit) => [edit.plateId, edit.fields]))
  const effective = new Map(
    baseline.map((plate) => [
      plate.id,
      { ...plate, ...editsById.get(plate.id) },
    ])
  )
  const changes = new Map<string, EditableFields>()
  const affectedFamilies = new Set<string | undefined>()
  const changePlate = (id: string, fields: EditableFields) => {
    const current = effective.get(id)!
    affectedFamilies.add(current.templateFamily)
    affectedFamilies.add(fields.templateFamily)
    changes.set(id, { ...changes.get(id), ...fields })
    effective.set(id, { ...current, ...fields })
  }

  let order = previousOrder
  let merge: FamilyMergeResult | undefined
  for (const { plateIds, placement, promote } of moves) {
    if (!plateIds.length || plateIds.some((id) => !effective.has(id)))
      return {
        ok: false,
        error: 'invalid_state',
        reasons: ['Every moved plate must belong to this state.'],
      }
    const families = groupFamilies(
      order.map((id, sortOrder) => {
        const plate = effective.get(id)!
        return { ...plate, sortOrder, templateRole: familyRole(plate) }
      })
    )
    const familyByHead = new Map(
      families.map((family) => [family.template.id, family])
    )
    const anchorId = 'anchorId' in placement ? placement.anchorId : undefined
    const anchor = anchorId ? effective.get(anchorId) : undefined
    if (anchorId && (!anchor || anchor.deleted))
      return {
        ok: false,
        error: 'superseded_revision',
        reasons: ['The target plate is no longer available.'],
      }
    const family = anchorId ? familyByHead.get(anchorId) : undefined
    if (
      (placement.kind === 'before' ||
        placement.kind === 'after' ||
        placement.kind === 'join') &&
      (!family || family.template.templateRole !== 'template')
    )
      return {
        ok: false,
        error: 'superseded_revision',
        reasons: ['The target is no longer an active Template.'],
      }

    const moving = new Set<string>()
    if (placement.kind === 'join') {
      const plan = planFamilyMerge(
        families,
        family!,
        plateIds,
        undefined,
        false
      )
      for (const [id, fields] of plan.changes) changePlate(id, fields)
      merge = plan.result
      for (const id of merge.moved) moving.add(id)
    } else {
      const used = new Set(
        [...effective.values()].map((plate) => plate.templateFamily)
      )
      for (const id of plateIds) {
        const plate = effective.get(id)!
        if (plate.deleted)
          return {
            ok: false,
            error: 'superseded_revision',
            reasons: ['A moved plate was deleted.'],
          }
        if (familyRole(plate) === 'template') {
          for (const variant of familyByHead.get(id)?.variants ?? [])
            moving.add(variant.id)
        } else if (promote && familyRole(plate) === 'variant') {
          const base = `${state.toLowerCase()}_${id.slice(id.indexOf('.') + 1)}`
          let slug = base
          let suffix = 2
          while (used.has(slug)) slug = `${base}_${suffix++}`
          used.add(slug)
          changePlate(id, {
            templateRole: 'template',
            variantOfPlateId: null,
            templateFamily: slug,
          })
        } else if (
          placement.kind !== 'before-plate' &&
          placement.kind !== 'after-plate'
        ) {
          return {
            ok: false,
            error: 'superseded_revision',
            reasons: ['A moved plate is no longer a Template.'],
          }
        } else {
          const source = families.find((family) =>
            family.variants.some((variant) => variant.id === id)
          )
          if (
            !source ||
            (anchorId !== source.template.id &&
              !source.variants.some((variant) => variant.id === anchorId))
          )
            return {
              ok: false,
              error: 'superseded_revision',
              reasons: ['The Variant and its target no longer share a family.'],
            }
          if (
            placement.kind === 'before-plate' &&
            anchorId === source.template.id
          )
            return { ok: false, error: 'invalid_state' }
        }
        moving.add(id)
      }
    }

    if (!moving.size) continue
    if (anchorId && moving.has(anchorId))
      return {
        ok: false,
        error: 'invalid_state',
        reasons: ['A moved plate cannot be its own destination.'],
      }
    const block = order.filter((id) => moving.has(id))
    const remaining = order.filter((id) => !moving.has(id))
    const after = placement.kind === 'after' || placement.kind === 'join'
    const familyMembers = new Set([
      anchorId,
      ...(family?.variants.map(({ id }) => id) ?? []),
    ])
    const index =
      placement.kind === 'start'
        ? 0
        : placement.kind === 'end'
          ? remaining.length
          : after
            ? remaining.findLastIndex((id) => familyMembers.has(id)) + 1
            : remaining.indexOf(anchorId!) +
              Number(placement.kind === 'after-plate')
    order = [...remaining.slice(0, index), ...block, ...remaining.slice(index)]
    if (merge) merge.moved = block
  }

  if (!validRegroup(effective, affectedFamilies, new Set(changes.keys())))
    return {
      ok: false,
      error: 'invalid_state',
      reasons: ['The move would leave an inconsistent family or Variant link.'],
    }
  const first = effective.get(order[0])
  if (!first || first.deleted || familyRole(first) !== 'template')
    return { ok: false, error: 'standard_invalid_template' }
  const orderChanged = !sameList(previousOrder, order)
  if (!orderChanged && !changes.size && !standard)
    return { ok: true, value: { batch, ...(merge && { merge }) } }
  const changesStandard =
    order[0] !== previousOrder[0] ||
    !!standard ||
    baseline.some(
      (plate) =>
        (editsById.get(plate.id)?.isStandard ?? plate.isStandard) &&
        changes.get(plate.id)?.templateRole === 'variant'
    )
  const combined = await standardEdits(
    d,
    actor,
    batch,
    baseline,
    order,
    changes,
    standard,
    {
      existingEdits: edits,
      preserveStandard: !changesStandard,
    }
  )
  if (!combined.ok) return combined
  if (
    !orderChanged &&
    !combined.value.edits.length &&
    !combined.value.deleteEditsFor.length
  )
    return { ok: true, value: { batch, ...(merge && { merge }) } }
  const changedAt = d.now()
  let next: ReviewBatch = {
    ...batch,
    lastChangedAt: changedAt,
    plateIds: combined.value.plateIds,
    state: 'open',
    approval: null,
    revision: batch.revision + 1,
    ...(orderChanged && {
      stateOrders: { ...batch.stateOrders, [state]: order },
      stateOrderChangedAt: { ...batch.stateOrderChangedAt, [state]: changedAt },
      baselineOrders: {
        ...batch.baselineOrders,
        [state]: batch.baselineOrders?.[state] ?? baselineOrder,
      },
    }),
  }
  if (orderChanged) next = resolveConflicts(next, { state })
  for (const [plateId, fields] of changes)
    next = resolveConflicts(next, { plateId, fields: Object.keys(fields) })
  const saved = await d.store.commit(batchId, batch.revision, {
    batch: next,
    by: actor,
    ...combined.value,
  })
  if (saved === 'revision_mismatch') return retryDraft
  return saved === 'ok'
    ? { ok: true, value: { batch: next, ...(merge && { merge }) } }
    : { ok: false, error: saved }
}
