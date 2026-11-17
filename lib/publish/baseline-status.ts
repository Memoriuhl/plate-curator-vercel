import { publishBaselineError } from './baseline'
import type { PublishDeps } from './types'
import type { ReviewBatch } from '../review/types'

export async function publishBaselineStatus(d: Pick<PublishDeps, 'pointer' | 'records'>, batch: ReviewBatch) {
  const [pointer, receipt] = await Promise.all([d.pointer.read(), d.records.get(`${batch.id}@${batch.revision}`)])
  const error = publishBaselineError(batch.baselineVersion, pointer.version, receipt)
  return { error, reviewedVersion: batch.baselineVersion, liveVersion: pointer.version }
}
