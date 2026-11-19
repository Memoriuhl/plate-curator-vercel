import { batchStepRetired } from '../../../../../lib/server/retired'

/** Retired with per-person Batches; the shared draft has no approve step. */
export function POST() {
  return batchStepRetired()
}
