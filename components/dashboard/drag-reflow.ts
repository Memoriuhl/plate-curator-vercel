import {
  orderForDrop,
  type DragFamily,
  type DragItem,
  type DropTarget,
} from './drop-targets'

/** Compare drop targets by operation and destination to avoid redundant drag updates. */
export function sameDropTarget(a: DropTarget | null, b: DropTarget | null) {
  if (!a || !b) return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'family-slot' && b.kind === 'family-slot')
    return a.index === b.index
  if (a.kind === 'variant-slot' && b.kind === 'variant-slot')
    return a.index === b.index && a.familyId === b.familyId
  return a.kind === 'merge' && b.kind === 'merge' && a.familyId === b.familyId
}

/** Compute the temporary order and lifted-item presentation for a possible drop. */
export function reflowForDrop(
  families: DragFamily[],
  item: DragItem,
  target: DropTarget | null
) {
  const order = target && orderForDrop(families, item, target)
  if (!order) return null
  const positions = new Map(order.map((id, index) => [id, index]))
  const promoted = item.kind === 'variant' && target?.kind === 'family-slot'
  const preview = families.map((family) => ({
    ...family,
    variants: family.variants
      .filter((plate) => !promoted || plate.id !== item.plate.id)
      .toSorted((a, b) => positions.get(a.id)! - positions.get(b.id)!),
  }))
  if (promoted) preview.push({ template: item.plate, variants: [] })
  preview.sort(
    (a, b) => positions.get(a.template.id)! - positions.get(b.template.id)!
  )
  return {
    families: preview,
    order,
    placeholder: {
      id: item.plate.id,
      kind: promoted ? ('family' as const) : item.kind,
    },
  }
}
