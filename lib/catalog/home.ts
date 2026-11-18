import type { CuratorState, Snapshot, StateProgress } from './types'

/** Summarize per-state plate counts and saved progress for the dashboard navigation. */
export function stateSummaries(
  snapshot: Snapshot,
  curator: CuratorState
): {
  state: string
  plateCount: number
  progress: StateProgress | null
}[] {
  const counts = new Map<string, number>()
  for (const plate of snapshot.plates) {
    counts.set(plate.state, (counts.get(plate.state) ?? 0) + 1)
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([state, plateCount]) => ({
      state,
      plateCount,
      progress: curator.stateProgress[state] ?? null,
    }))
}
