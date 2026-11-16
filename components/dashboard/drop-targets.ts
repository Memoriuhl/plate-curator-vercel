import type { PlateCardData } from '@/lib/catalog/dashboard-types'

export type DragFamily = { template: PlateCardData; variants: PlateCardData[] }
export type DragItem = { kind: 'family' | 'variant'; plate: PlateCardData }
export type DropTarget =
  | { kind: 'family-slot'; index: number }
  | { kind: 'variant-slot'; familyId: string; index: number }
  | { kind: 'merge'; familyId: string }
export type TargetRect = { target: DropTarget; rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>; scrollElement?: HTMLElement }

export function pastDragThreshold(dx: number, dy: number) {
  return Math.hypot(dx, dy) >= 5
}

export function familyOrder(families: DragFamily[]) {
  return families.flatMap(({ template, variants }) => [template.id, ...variants.map(plate => plate.id)])
}

export function newFamilySlug(plate: PlateCardData, families: DragFamily[]) {
  const base = `${plate.state.toLowerCase()}_${plate.id.slice(plate.id.indexOf('.') + 1)}`
  const used = new Set(families.flatMap(family => [family.template, ...family.variants]).filter(candidate => candidate.state === plate.state).map(candidate => candidate.templateFamily))
  let slug = base
  let suffix = 2
  while (used.has(slug)) slug = `${base}_${suffix++}`
  return slug
}

export function moveBlock(order: string[], block: string[], index: number) {
  const selected = new Set(block)
  const insertion = order.slice(0, index).filter(id => !selected.has(id)).length
  const rest = order.filter(id => !selected.has(id))
  return [...rest.slice(0, insertion), ...order.filter(id => selected.has(id)), ...rest.slice(insertion)]
}

export function orderForDrop(families: DragFamily[], item: DragItem, target: DropTarget) {
  const order = familyOrder(families)
  const source = families.find(family => family.template.id === item.plate.id || family.variants.some(plate => plate.id === item.plate.id))
  if (!source || target.kind === 'merge') return null
  if (target.kind === 'variant-slot') {
    if (item.kind !== 'variant' || target.familyId !== source.template.id) return null
    const index = order.indexOf(source.template.id) + 1 + Math.min(source.variants.length, Math.max(0, target.index))
    return moveBlock(order, [item.plate.id], index)
  }
  const index = families.slice(0, Math.max(0, target.index)).reduce((sum, family) => sum + 1 + family.variants.length, 0)
  return moveBlock(order, item.kind === 'family' ? [source.template.id, ...source.variants.map(plate => plate.id)] : [item.plate.id], index)
}

export function targetAt(x: number, y: number, targets: TargetRect[]): DropTarget | null {
  const hit = targets.filter(({ rect }) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
  return hit.find(({ target }) => target.kind !== 'merge')?.target ?? hit[0]?.target ?? null
}

export function scrollVelocity(y: number, height: number) {
  if (y < 80) return -Math.ceil(18 * Math.max(0, 1 - y / 80))
  if (y > height - 80) return Math.ceil(18 * Math.max(0, 1 - (height - y) / 80))
  return 0
}
