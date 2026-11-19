import { batchStepRetired } from '../../../../../lib/server/retired'

/** Retired with per-person Batches; the shared draft has no copy step. */
export function POST() {
  return batchStepRetired()
}
