import { createHash } from 'node:crypto'
import { familyRole, groupFamiliesInOrder } from '../catalog/families'
import { JURISDICTIONS } from '../catalog/jurisdictions'
import {
  hasValidStandard,
  preservesStandardPosition,
} from '../catalog/standard-position'
import { canEdit, editableStates } from './access'
import { validRegroup } from './batch'
import { orderOnto, resolveConflicts, sameList } from './draft'
import { planFamilyMerge, type FamilyMergeResult } from './family-merge-plan'
import { standardEdits } from './standard'
import type { StateMove } from './state-move'
import type {
  Actor,
  EditableFields,
  ReviewBatch,
  ReviewDeps,
  ReviewStore,
  StandardChange,
} from './types'

type Input = {
  batchId: string
  operationId: string
  state: string
  moves: StateMove[]
  standard?: StandardChange
  familyEndpoint?: true
}

type Plan = Parameters<ReviewStore['transactStateMove']>[3]

function loadMoveCatalog(
  d: ReviewDeps,
  version: number,
  { state, moves }: Input
) {
  const statePlates = d.stateBaseline(version, state)
  const catalog = moves.some(
    ({ promote, placement }) => promote || placement.kind === 'join'
  )
    ? d.catalogFamilies
      ? d.catalogFamilies(version)
      : Promise.all(
          Object.keys(JURISDICTIONS)
            .filter((code) => code !== state)
            .map((code) => d.stateBaseline(version, code, 'snapshot'))
        ).then((states) => states.flat())
    : Promise.resolve([])
  return Promise.all([statePlates, catalog])
}

/** Apply placements to the current draft in Firestore commit order. */
export function moveState(d: ReviewDeps, actor: Actor, input: Input) {
  const { batchId, operationId, state, moves, standard, familyEndpoint } = input
  // Keep the fingerprint of requests that may already have a committed receipt.
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        actor.uid,
        state,
        moves,
        standard,
        familyEndpoint ? !standard : undefined,
      ])
    )
    .digest('hex')
  const prepared = new Map<number, ReturnType<typeof loadMoveCatalog>>()
  const load = (version: number) => {
    let catalog = prepared.get(version)
    if (!catalog) {
      catalog = loadMoveCatalog(d, version, input)
      prepared.set(version, catalog)
    }
    return catalog
  }
  return d.store.transactStateMove(
    batchId,
    operationId,
    fingerprint,
    (detail) => planStateMove(d, actor, input, detail, load),
    load
  )
}

async function planStateMove(
  d: ReviewDeps,
  actor: Actor,
  { state, moves, standard }: Input,
  detail: Parameters<Plan>[0],
  load: (version: number) => ReturnType<typeof loadMoveCatalog>
): ReturnType<Plan> {
  const { batch, edits } = detail
  if (!canEdit(batch, actor)) return { ok: false, error: 'forbidden' }
  if (!editableStates.includes(batch.state))
    return { ok: false, error: 'invalid_state' }

  const [statePlates, catalog] = await load(batch.baselineVersion)
  const baseline = statePlates.filter((plate) => plate.state === state)
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
  const before = [...effective.values()]
  const changes = new Map<string, EditableFields>()
  const affectedFamilies = new Set<string | undefined>()
  const otherLabels = new Set<string>()
  for (const plate of catalog) {
    if (plate.state === state) continue
    const member = { ...plate, ...editsById.get(plate.id) }
    if (!member.deleted && member.templateFamily)
      otherLabels.add(member.templateFamily)
  }
  const allocateLabel = (base: string) => {
    const used = new Set(
      [...effective.values()].flatMap((plate) =>
        !plate.deleted && plate.templateFamily ? [plate.templateFamily] : []
      )
    )
    let label = base
    let suffix = 2
    while (used.has(label) || otherLabels.has(label))
      label = `${base}_${suffix++}`
    return label
  }
  const changePlate = (id: string, fields: EditableFields) => {
    const current = effective.get(id)!
    affectedFamilies.add(current.templateFamily)
    affectedFamilies.add(fields.templateFamily)
    changes.set(id, { ...changes.get(id), ...fields })
    effective.set(id, { ...current, ...fields })
  }

  const groupedOrder = (ids: readonly string[]) =>
    groupFamiliesInOrder(ids.map((id) => effective.get(id)!))
  const firstBefore = groupedOrder(previousOrder)[0]?.template.id
  let order = previousOrder
  let merge: FamilyMergeResult | undefined
  for (const { plateIds, placement, promote } of moves) {
    if (!plateIds.length || plateIds.some((id) => !effective.has(id)))
      return {
        ok: false,
        error: 'invalid_state',
        reasons: ['Every moved plate must belong to this state.'],
      }
    const families = groupedOrder(order)
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
      (!family ||
        family.template.templateRole === 'variant' ||
        (placement.kind === 'join' &&
          family.template.templateRole !== 'template'))
    )
      return {
        ok: false,
        error: 'superseded_revision',
        reasons: ['The target no longer supports this placement.'],
      }

    const moving = new Set<string>()
    if (placement.kind === 'join') {
      const plan = planFamilyMerge(
        families,
        family!,
        plateIds,
        undefined,
        false,
        family!.template.templateFamily || allocateLabel(family!.template.id)
      )
      for (const [id, fields] of plan.changes) changePlate(id, fields)
      merge = plan.result
      for (const id of merge.moved) moving.add(id)
    } else {
      for (const id of plateIds) {
        const plate = effective.get(id)!
        if (plate.deleted)
          return {
            ok: false,
            error: 'superseded_revision',
            reasons: ['A moved plate was deleted.'],
          }
        if (familyRole(plate) !== 'variant') {
          for (const variant of familyByHead.get(id)?.variants ?? [])
            moving.add(variant.id)
        } else if (promote && familyRole(plate) === 'variant') {
          const base = `${state.toLowerCase()}_${id.slice(id.indexOf('.') + 1)}`
          changePlate(id, {
            templateRole: 'template',
            variantOfPlateId: null,
            templateFamily: allocateLabel(base),
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
    // Family edges refer to the displayed blocks. An ordinary family edit can
    // attach a Variant without changing its stored position.
    const placementOrder =
      placement.kind === 'before' || placement.kind === 'after'
        ? families.flatMap(({ template, variants }) => [
            template.id,
            ...variants.map(({ id }) => id),
          ])
        : order
    let block = placementOrder.filter((id) => moving.has(id))
    if (promote) {
      // Explicitly promoted Variants get their own blocks. Retained Variants stay
      // beside their selected Template, even when a former sibling preceded them.
      block = groupedOrder(block).flatMap(({ template, variants }) => [
        template.id,
        ...variants.map(({ id }) => id),
      ])
    }
    const remaining = placementOrder.filter((id) => !moving.has(id))
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

  if (
    !validRegroup(effective, affectedFamilies, new Set(changes.keys())) ||
    [...effective.values()].some(
      (plate) =>
        !plate.deleted &&
        plate.templateFamily &&
        affectedFamilies.has(plate.templateFamily) &&
        otherLabels.has(plate.templateFamily)
    )
  )
    return {
      ok: false,
      error: 'invalid_state',
      reasons: ['The move would leave an inconsistent family or Variant link.'],
    }
  const firstAfter = groupedOrder(order)[0]?.template.id
  const preserveStandard =
    !standard &&
    preservesStandardPosition(
      before,
      [...effective.values()],
      firstBefore,
      firstAfter
    )
  const orderChanged = !sameList(previousOrder, order)
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
      preserveStandard,
      firstId: firstAfter,
    }
  )
  if (!combined.ok) return combined
  const changedFields = new Map(
    combined.value.edits.map((edit) => [edit.plateId, edit.fields])
  )
  const removed = new Set(combined.value.deleteEditsFor)
  if (
    !preserveStandard &&
    !hasValidStandard(
      baseline.map((plate) => ({
        ...plate,
        ...(removed.has(plate.id)
          ? undefined
          : (changedFields.get(plate.id) ?? editsById.get(plate.id))),
      })),
      firstAfter
    )
  )
    return { ok: false, error: 'standard_invalid_template' }
  if (
    !orderChanged &&
    !combined.value.edits.length &&
    !combined.value.deleteEditsFor.length
  )
    return {
      ok: true,
      value: { revision: batch.revision, order, ...(merge && { merge }) },
    }
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
  return {
    ok: true,
    value: { revision: next.revision, order, ...(merge && { merge }) },
    mutation: { batch: next, by: actor, ...combined.value },
  }
}
