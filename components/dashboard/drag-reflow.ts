import {
  familyOrder,
  moveBlock,
  type DragFamily,
  type DragItem,
  type DropTarget,
} from './drop-targets'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'

/** Compare drop targets by operation and destination to avoid redundant drag updates. */
export function sameDropTarget(a: DropTarget | null, b: DropTarget | null) {
  if (!a || !b) return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'family-slot' && b.kind === 'family-slot')
    return a.index === b.index && a.background === b.background
  if (a.kind === 'variant-slot' && b.kind === 'variant-slot')
    return a.index === b.index && a.familyId === b.familyId
  return a.kind === 'merge' && b.kind === 'merge' && a.familyId === b.familyId
}

/** Compute the temporary order and lifted-item presentation for a possible drop. */
export function reflowForDrop(
  families: DragFamily[],
  item: DragItem,
  target: DropTarget | null,
  selection: readonly PlateCardData[] = [item.plate]
) {
  if (!target || target.kind === 'merge') return null
  const selected = new Set(
    selection
      .filter((plate) => !plate.deleted && plate.state === item.plate.state)
      .map((plate) => plate.id)
  )
  if (target.kind === 'variant-slot') {
    const source = families.find(
      ({ template }) => template.id === target.familyId
    )
    if (
      item.kind !== 'variant' ||
      !source?.variants.some((plate) => plate.id === item.plate.id)
    )
      return null
    const byId = new Map(source.variants.map((plate) => [plate.id, plate]))
    const ids = [...byId.keys()]
    const plateIds = ids.filter((id) => selected.has(id))
    const variants = moveBlock(ids, plateIds, target.index).map((id) =>
      byId.get(id)!
    )
    const preview = families.map((family) =>
      family === source ? { ...family, variants } : family
    )
    return {
      families: preview,
      order: familyOrder(preview),
      plateIds,
      promoted: [],
      placeholder: { id: item.plate.id, kind: item.kind },
    }
  }

  const remaining: DragFamily[] = []
  const moving: DragFamily[] = []
  const promoted: PlateCardData[] = []
  let insertion = 0
  for (const [index, { template, variants }] of families.entries()) {
    const kept = variants.filter(
      ({ id, deleted }) => deleted || !selected.has(id)
    )
    const family = { template, variants: kept }
    if (!template.deleted && selected.has(template.id)) {
      moving.push(family)
      if (template.templateRole === 'variant') promoted.push(template)
    } else {
      remaining.push(family)
      if (index < target.index) insertion++
    }
    for (const plate of variants) {
      if (!plate.deleted && selected.has(plate.id)) {
        moving.push({ template: plate, variants: [] })
        promoted.push(plate)
      }
    }
  }
  if (!moving.length) return null
  const preview = [
    ...remaining.slice(0, insertion),
    ...moving,
    ...remaining.slice(insertion),
  ]
  return {
    families: preview,
    order: familyOrder(preview),
    plateIds: moving.map(({ template }) => template.id),
    promoted,
    placeholder: {
      id: item.plate.id,
      kind: 'family' as const,
    },
  }
}
