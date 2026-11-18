export const BASELINE_ERRORS = {
  stale: 'stale_baseline',
  receiptConflict: 'receipt_baseline_conflict',
} as const

export type BaselineError = typeof BASELINE_ERRORS[keyof typeof BASELINE_ERRORS]

/**
 * Identify baseline-specific failures so callers can give the curator a recovery path.
 */
export function isBaselineError(error: unknown): error is BaselineError {
  return error === BASELINE_ERRORS.stale || error === BASELINE_ERRORS.receiptConflict
}

/**
 * Determine whether a receipt can resume from this live pointer or whether the batch
 * needs a fresh baseline.
 */
export function publishBaselineError(reviewedVersion: number, liveVersion: number, receipt: { fromVersion: number; committedAt?: string } | null): BaselineError | null {
  if (receipt?.committedAt) return null
  if (receipt && receipt.fromVersion !== reviewedVersion) return BASELINE_ERRORS.receiptConflict
  return liveVersion !== reviewedVersion ? BASELINE_ERRORS.stale : null
}
