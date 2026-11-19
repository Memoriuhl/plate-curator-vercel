import type { Actor, ReviewBatch } from './types'

export const editableStates = ['open', 'submitted', 'approved']

export function canCopyForFreshReview(
  batch: Pick<ReviewBatch, 'state' | 'baselineVersion'>,
  targetVersion: number
): boolean {
  return (
    batch.state === 'approved' ||
    ((batch.state === 'open' || batch.state === 'submitted') &&
      targetVersion > batch.baselineVersion)
  )
}

/**
 * Decide who may write to a batch. Every active curator edits the shared draft; a
 * release (the frozen copy of the draft being published) is never edited. Batches made
 * before the shared draft keep their old rule (creator or Owner); the API only routes
 * writes to the shared draft, so those Batches are read-only history in the app.
 */
export function canEdit(
  batch: Pick<ReviewBatch, 'createdBy' | 'kind'>,
  actor: Actor
): boolean {
  if (batch.kind === 'shared-draft') return true
  if (batch.kind === 'release') return false
  return batch.createdBy === actor.uid || actor.role === 'owner'
}
