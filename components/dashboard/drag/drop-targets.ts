import type { PlateCardData } from '@/lib/catalog/dashboard-types'

export type DragFamily = { template: PlateCardData; variants: PlateCardData[] }
export type DragItem = { kind: 'family' | 'variant'; plate: PlateCardData }
export type FamilySlot = {
  kind: 'family-slot'
  index: number
  background?: true
  anchor?: { kind: 'before' | 'after'; anchorId: string }
}
export type DropTarget =
  | FamilySlot
  | { kind: 'variant-slot'; familyId: string; index: number }
  | { kind: 'merge'; familyId: string }
export type TargetRect = {
  target: DropTarget
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>
  scrollElement?: HTMLElement
}

/** Require a small pointer movement before treating a press as a drag. */
export function pastDragThreshold(dx: number, dy: number) {
  return Math.hypot(dx, dy) >= 5
}

/** Flatten displayed families to the plate order persisted for the state. */
export function familyOrder(families: DragFamily[]) {
  return families.flatMap(({ template, variants }) => [
    template.id,
    ...variants.map((plate) => plate.id),
  ])
}

/** Choose an unused family slug when a plate becomes a new template. */
export function newFamilySlug(plate: PlateCardData, families: DragFamily[]) {
  const base = `${plate.state.toLowerCase()}_${plate.id.slice(plate.id.indexOf('.') + 1)}`
  const used = new Set(
    families
      .flatMap((family) => [family.template, ...family.variants])
      .filter((candidate) => candidate.state === plate.state)
      .map((candidate) => candidate.templateFamily)
  )
  let slug = base
  let suffix = 2
  while (used.has(slug)) slug = `${base}_${suffix++}`
  return slug
}

/**
 * Move a block of selected IDs together while accounting for the slots removed from the
 * original order.
 */
export function moveBlock(order: string[], block: string[], index: number) {
  const selected = new Set(block)
  const insertion = order
    .slice(0, index)
    .filter((id) => !selected.has(id)).length
  const rest = order.filter((id) => !selected.has(id))
  return [
    ...rest.slice(0, insertion),
    ...order.filter((id) => selected.has(id)),
    ...rest.slice(insertion),
  ]
}

/** Pick the most specific drop target under the pointer when hit areas overlap. */
export function targetAt(
  x: number,
  y: number,
  targets: TargetRect[]
): DropTarget | null {
  const hit = targets.filter(
    ({ rect }) =>
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  )
  return (
    hit.find(({ target }) => target.kind === 'variant-slot')?.target ??
    hit.find(({ target }) => target.kind === 'family-slot')?.target ??
    hit[0]?.target ??
    null
  )
}

/** Compute a signed scroll speed from the pointer's proximity to a viewport edge. */
export function scrollVelocity(y: number, height: number) {
  if (y < 80) return -Math.ceil(18 * Math.min(1, Math.max(0, 1 - y / 80)))
  if (y > height - 80)
    return Math.ceil(18 * Math.min(1, Math.max(0, 1 - (height - y) / 80)))
  return 0
}

/** Find the nearest family insertion slot when a drop must place a new family. */
export function nearestFamilyTarget(
  x: number,
  y: number,
  targets: TargetRect[],
  familyCount: number
): FamilySlot {
  const slots = targets.filter((entry) => entry.target.kind === 'family-slot')
  const end: FamilySlot = {
    kind: 'family-slot',
    index: familyCount,
    background: true,
  }
  if (!slots.length || y > Math.max(...slots.map((entry) => entry.rect.bottom)))
    return end
  let nearest = end
  let distance = Infinity
  for (const { target, rect } of slots) {
    const dx = Math.max(rect.left - x, 0, x - rect.right)
    const dy = Math.max(rect.top - y, 0, y - rect.bottom)
    const next = dx * dx + dy * dy
    if (next < distance && target.kind === 'family-slot') {
      distance = next
      nearest = { ...target, background: true }
    }
  }
  return nearest
}

/** Compute the state order after promoting selected plates into their own families. */
export function promotionOrder(families: DragFamily[], ids: readonly string[]) {
  const promoted = new Set(ids)
  return families.flatMap((family) => [
    family.template.id,
    ...family.variants
      .filter((plate) => !promoted.has(plate.id))
      .map((plate) => plate.id),
    ...family.variants
      .filter((plate) => promoted.has(plate.id))
      .map((plate) => plate.id),
  ])
}
