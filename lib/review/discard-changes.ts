import { canEdit, editableStates } from './access'
import { editableKeys } from './fields'
import { orderDifferences, restorePlateOrder } from './order-diff'
import { retryDraftRace, unchangedSince } from './preconditions'
import { commitDraftRevert } from './draft/revert-commit'
import type {
  Actor,
  DraftChangeTarget,
  Outcome,
  ReviewBatch,
  ReviewDeps,
} from './types'

type DiscardInput = {
  batchId: string
  plateId: string
  batchRevision: number
  target: DraftChangeTarget
}

/** Restore one field or position to live without changing any companion field or plate. */
export function discardPlateChanges(
  d: ReviewDeps,
  actor: Actor,
  { batchId, plateId, batchRevision, target }: DiscardInput
): Promise<Outcome<ReviewBatch>> {
  return retryDraftRace(async () => {
    const snapshot = await d.store.readBatch(batchId)
    if (!snapshot) return { ok: false, error: 'not_found' }
    const { batch, edits } = snapshot
    if (!canEdit(batch, actor)) return { ok: false, error: 'forbidden' }
    if (!editableStates.includes(batch.state))
      return { ok: false, error: 'invalid_state' }
    const dropAll = target === 'all'
    const touchesOrder = dropAll || target === 'order'
    const baseline = await d.baselineAtVersion(batch.baselineVersion, plateId)
    if (!baseline) return { ok: false, error: 'not_found' }
    const { state } = baseline
    if (
      !(await unchangedSince(d, batch, batchRevision, {
        plateIds: touchesOrder && !dropAll ? [] : [plateId],
        orderStates: touchesOrder ? [state] : [],
      }))
    )
      return { ok: false, error: 'superseded_revision' }

    const current = edits.find((edit) => edit.plateId === plateId)
    const remove = dropAll ? editableKeys : target === 'order' ? [] : [target]
    const restored = remove.filter(
      (field) =>
        Object.hasOwn(current?.fields ?? {}, field) ||
        !!current?.pipelineChanges?.[field]
    )
    const fields = { ...current?.fields }
    for (const field of restored) delete fields[field]

    let position
    const order = batch.stateOrders[state]
    if (touchesOrder && order?.includes(plateId)) {
      const live =
        batch.baselineOrders?.[state] ??
        (await d.stateBaseline(batch.baselineVersion, state)).map(
          (plate) => plate.id
        )
      if (
        !dropAll ||
        orderDifferences(live, order).some((move) => move.plateId === plateId)
      ) {
        const next = restorePlateOrder(live, order, plateId)
        if (next.some((id, index) => id !== order[index]))
          position = { state, baseline: live, order: next }
      }
    }
    return commitDraftRevert(
      d,
      actor,
      snapshot,
      current && (restored.length || dropAll)
        ? [
            {
              baseline,
              previous: current,
              fields,
              restored,
              discardAll: dropAll,
            },
          ]
        : [],
      position
    )
  })
}
