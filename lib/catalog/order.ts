import type { CuratorState, Plate, Snapshot } from './types'

export function orderedStatePlates(snapshot: Snapshot, state: string, curator: CuratorState): Plate[] {
  const positions = new Map((curator.stateOrder[state] ?? []).map((id, index) => [id, index]))
  return snapshot.plates.filter(plate => plate.state === state).sort((a, b) => {
    const aPosition = positions.get(a.id)
    const bPosition = positions.get(b.id)
    if (aPosition !== undefined && bPosition !== undefined) return aPosition - bPosition
    if (aPosition !== undefined) return -1
    if (bPosition !== undefined) return 1
    return (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity) || a.id.localeCompare(b.id)
  })
}
