import { limits } from './fields'

export type StatePlacement =
  | { kind: 'start' | 'end' }
  | {
      kind: 'before' | 'after' | 'before-plate' | 'after-plate' | 'join'
      anchorId: string
    }

export type StateMove = {
  plateIds: string[]
  placement: StatePlacement
  promote?: true
}

export function parseStateMoves(value: unknown): StateMove[] | null {
  if (!Array.isArray(value) || !value.length || value.length > limits.plates)
    return null
  const seen = new Set<string>()
  const moves: StateMove[] = []
  const isId = (id: unknown): id is string =>
    typeof id === 'string' && !!id.trim() && id.length <= limits.text
  for (const move of value) {
    if (
      !move ||
      !Array.isArray(move.plateIds) ||
      !move.plateIds.length ||
      move.plateIds.length + seen.size > limits.plates ||
      (move.promote !== undefined && move.promote !== true) ||
      !move.placement
    )
      return null
    for (const id of move.plateIds) {
      if (!isId(id) || seen.has(id)) return null
      seen.add(id)
    }
    const { kind, anchorId } = move.placement
    if (kind === 'start' || kind === 'end') {
      moves.push({
        plateIds: move.plateIds,
        placement: { kind },
        ...(move.promote && { promote: true }),
      })
    } else if (
      isId(anchorId) &&
      (kind === 'before' ||
        kind === 'after' ||
        kind === 'before-plate' ||
        kind === 'after-plate' ||
        (kind === 'join' && value.length === 1 && !move.promote))
    ) {
      moves.push({
        plateIds: move.plateIds,
        placement: { kind, anchorId },
        ...(move.promote && { promote: true }),
      })
    } else return null
  }
  return moves
}
