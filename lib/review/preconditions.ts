import { draftCommitAttempts, draftRetryPause } from './retry'
import type { Outcome, ReviewBatch, ReviewDeps } from './types'

/** What an operation reads and writes, for its concurrency precondition. */
export type DraftTouch = {
  plateIds?: Iterable<string>
  orderStates?: Iterable<string>
}

/** Returned by one attempt when the draft moved under it and it should re-read. */
export const retryDraft = Symbol('retryDraft')

/**
 * Check that nothing an operation touches changed after the draft revision the curator
 * saw. On the shared draft a newer revision only blocks the operation when a later
 * commit wrote one of its plates or reordered one of its states, so curators working on
 * different plates or states never block each other. Batches made before the shared
 * draft keep the old exact-revision rule.
 */
export async function unchangedSince(
  d: ReviewDeps,
  batch: ReviewBatch,
  seen: number,
  touch: DraftTouch
): Promise<boolean> {
  if (seen === batch.revision) return true
  if (
    batch.kind !== 'shared-draft' ||
    seen > batch.revision ||
    seen < (batch.rebaseFloor ?? 0) ||
    !d.store.listChanges
  )
    return false
  const plates = new Set(touch.plateIds ?? [])
  const states = new Set(touch.orderStates ?? [])
  const changes = await d.store.listChanges(batch.id, seen)
  return !changes.some(
    (change) =>
      change.revision <= batch.revision &&
      (change.plateIds.some((id) => plates.has(id)) ||
        (change.orderStates ?? []).some((state) => states.has(state)))
  )
}

/**
 * Run a read-check-commit attempt until it commits, fails on its own precondition, or
 * runs out of attempts. Each attempt re-reads the draft, so a retry sees the other
 * writer's commit and re-applies the operation on top of it.
 */
export async function retryDraftRace<T>(
  attempt: () => Promise<Outcome<T> | typeof retryDraft>
): Promise<Outcome<T>> {
  for (let index = 0; index < draftCommitAttempts; index += 1) {
    await draftRetryPause(index)
    const result = await attempt()
    if (result !== retryDraft) return result
  }
  return { ok: false, error: 'superseded_revision' }
}
