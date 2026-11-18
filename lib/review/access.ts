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

/** Allow the batch creator or an owner to edit a review batch. */
export function canEdit(batch: ReviewBatch, actor: Actor): boolean {
  return batch.createdBy === actor.uid || actor.role === 'owner'
}
