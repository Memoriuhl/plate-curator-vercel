import type { StateMove } from '../review/state-move'

/** Active standalone plates can anchor a family position. */
export function placementHeads(
  families: readonly {
    template: { id: string; deleted?: boolean; templateRole: string | null }
  }[]
) {
  return families.flatMap(({ template }) =>
    !template.deleted && template.templateRole !== 'variant'
      ? [template.id]
      : []
  )
}

/** A drop in the first position must end with an active Template. */
export function allowsFirstPlacement(
  plate: { deleted?: boolean; templateRole: string | null } | undefined,
  promoted: boolean
) {
  return (
    !!plate &&
    !plate.deleted &&
    (plate.templateRole === 'template' ||
      (promoted && plate.templateRole === 'variant'))
  )
}

/** Translate the dragged plates' preview positions into anchored placements. */
export function placementsForOrder(
  order: readonly string[],
  plateIds: readonly string[],
  options?: { familyHeads?: readonly string[]; promote?: true }
): StateMove[] {
  const moving = new Set(plateIds)
  const familyHeads = options?.familyHeads && new Set(options.familyHeads)
  const visible = order.filter(
    (id) => !familyHeads || familyHeads.has(id) || moving.has(id)
  )
  const moves: StateMove[] = []
  for (let index = 0; index < visible.length; index++) {
    if (!moving.has(visible[index])) continue
    const start = index
    while (moving.has(visible[index + 1])) index++
    const next = visible[index + 1]
    const previous = visible[start - 1]
    moves.push({
      plateIds: visible.slice(start, index + 1),
      placement: next
        ? { kind: familyHeads ? 'before' : 'before-plate', anchorId: next }
        : previous
          ? { kind: familyHeads ? 'after' : 'after-plate', anchorId: previous }
          : { kind: 'start' },
      ...(options?.promote && { promote: true }),
    })
  }
  return moves
}
