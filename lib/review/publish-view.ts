import { orderDifferences } from './order-diff'
import type { DraftChange } from './checkpoint'
import type { DraftSnapshot } from './draft'

export type StatePublishSummary = {
  state: string
  /** Plates whose fields differ from the live catalog. */
  plates: number
  /** Plates whose position the saved order changes. */
  moved: number
  contributors: string[]
}

/**
 * Break the draft down by jurisdiction for the Publish view: what each state changes and
 * who contributed since the last publish. Publish ships every state together; there is
 * no per-state hold-back.
 */
export function draftPublishSummary(
  draft: DraftSnapshot,
  changes: DraftChange[]
): StatePublishSummary[] {
  const byState = new Map<
    string,
    { plates: Set<string>; moved: number; contributors: Set<string> }
  >()
  const entry = (state: string) => {
    let value = byState.get(state)
    if (!value) {
      value = { plates: new Set(), moved: 0, contributors: new Set() }
      byState.set(state, value)
    }
    return value
  }
  for (const edit of draft.edits) {
    if (!Object.keys(edit.fields).length) continue
    const state = entry(edit.plateId.split('.')[0])
    state.plates.add(edit.plateId)
    state.contributors.add(edit.authorName || edit.authorId)
  }
  for (const [state, order] of Object.entries(draft.batch.stateOrders ?? {})) {
    const baseline = draft.batch.baselineOrders?.[state]
    if (!baseline) continue
    const moved = orderDifferences(baseline, order).length
    if (moved) entry(state).moved = moved
  }
  for (const change of changes) {
    for (const state of change.states ?? []) {
      const summary = byState.get(state)
      if (!summary) continue
      for (const author of change.contributors)
        summary.contributors.add(author.name || author.uid)
    }
  }
  return [...byState]
    .map(([state, value]) => ({
      state,
      plates: value.plates.size,
      moved: value.moved,
      contributors: [...value.contributors].sort(),
    }))
    .filter((summary) => summary.plates > 0 || summary.moved > 0)
    .sort((left, right) => left.state.localeCompare(right.state))
}
