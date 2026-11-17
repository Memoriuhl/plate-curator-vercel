import type { Actor, ReviewBatch } from './types'

export const editableStates = ['open', 'submitted', 'approved']

export function canEdit(batch: ReviewBatch, actor: Actor): boolean {
  return batch.createdBy === actor.uid || actor.role === 'owner'
}
