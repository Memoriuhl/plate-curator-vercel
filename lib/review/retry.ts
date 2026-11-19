/**
 * Every draft commit compare-and-swaps the draft document's revision. Two writers that
 * touch different plates or states still race on that one document, so the loser
 * re-reads and tries again: its own precondition (the plate it edited, or the state it
 * reordered) decides whether the retry succeeds, never the other writer's change.
 *
 * Firestore sustains roughly one write per second on a single document, so retries back
 * off with full jitter instead of hammering it in lockstep.
 */
export const draftCommitAttempts = 8

const baseDelayMs = 15
const maxDelayMs = 400

/** Pick a full-jitter delay for the given zero-based retry. */
export function draftRetryDelay(attempt: number, random = Math.random) {
  return Math.floor(
    random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt + 1))
  )
}

/** Wait before the next attempt; the first attempt never waits. */
export async function draftRetryPause(attempt: number) {
  if (attempt === 0) return
  const delay = draftRetryDelay(attempt - 1)
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
}
