import type { PublishDeps } from './types'
import type { ReviewBatch } from '../review/types'

// Preflight only explains stale work. The step repeats the authoritative check under its lease.
export async function publishBaselineStatus(d: Pick<PublishDeps, 'pointer' | 'records'>, batch: ReviewBatch) {
  const [pointer, receipt] = await Promise.all([d.pointer.read(), d.records.get(`${batch.id}@${batch.revision}`)])
  const error = receipt
    ? !receipt.committedAt && receipt.fromVersion !== batch.baselineVersion ? 'receipt_baseline_conflict' as const : null
    : pointer.version !== batch.baselineVersion ? 'stale_baseline' as const : null
  return { error, reviewedVersion: batch.baselineVersion, liveVersion: pointer.version }
}
