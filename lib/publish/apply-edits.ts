import type { Plate } from '../catalog/types'
import type { EditableFields } from '../review/types'

/** Optional plate keys a null edit removes from the next Snapshot. */
const removableKeys = [
  'templateFamily',
  'templateRole',
  'variantOfPlateId',
  'firstIssuedYear',
  'wikiUrl',
  'colorDetail',
  'lineageColor',
] as const

/**
 * Build the next Snapshot's plates from baseline plates, a release's edits and its
 * state orders. Deleted plates are dropped, a null edit removes its key, and the
 * legacy template flag follows the family role so the two never disagree.
 */
export function applyReleaseEdits(
  plates: readonly Plate[],
  edits: readonly { plateId: string; fields: EditableFields }[],
  stateOrders: Record<string, string[]>
) {
  const fields = new Map(edits.map((edit) => [edit.plateId, edit.fields]))
  const orders = new Map(
    Object.entries(stateOrders).map(([state, order]) => [
      state,
      new Map(order.map((id, index) => [id, index])),
    ])
  )
  const deleted = new Set(
    edits
      .filter((edit) => edit.fields.deleted === true)
      .map((edit) => edit.plateId)
  )
  return {
    deleted,
    plates: plates
      .filter((plate) => !deleted.has(plate.id))
      .map((plate) => {
        const change: Record<string, unknown> = fields.get(plate.id) ?? {}
        const edited: Plate & { deleted?: boolean } = { ...plate, ...change }
        delete edited.deleted
        if (change.templateRole)
          edited.isTemplate = edited.templateRole === 'template'
        else if (change.templateRole === null) delete edited.isTemplate
        for (const key of removableKeys)
          if (change[key] === null) delete edited[key]
        const order = orders.get(plate.state)
        if (order) edited.sortOrder = order.get(plate.id)
        return edited as Plate
      }),
  }
}
