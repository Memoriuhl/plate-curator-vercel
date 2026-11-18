import type { ReviewBatch } from './types'

export function mostRecentBatch(
  batches: ReviewBatch[] | undefined
): ReviewBatch | undefined {
  const updated = (batch: ReviewBatch) =>
    (batch as ReviewBatch & { updatedAt?: string }).updatedAt ?? batch.createdAt
  return batches?.reduce<ReviewBatch | undefined>(
    (latest, batch) =>
      !latest || updated(batch) > updated(latest) ? batch : latest,
    undefined
  )
}
