import { batchApprovedFor } from './command'
import { publishRequesterStop } from './authority'
import { publishControlStop } from './control'
import { publishBaselineError } from './baseline/baseline'
import { PUBLISH_ERRORS } from './stop'
import type { ReviewBatch } from '../review/types'
import type {
  PublishCommand,
  PublishControlState,
  PublishError,
  PublishRecord,
  PublishStop,
} from './types'

export const CLAIM_TTL_MS = 120_000
/** Recognize terminal workflow states that allow an old claim to be taken over. */
export const terminalRun = (status?: string | null) =>
  status === 'completed' || status === 'failed' || status === 'cancelled'
export type RetryEligibility = {
  canRetry: boolean
  reason: PublishError | null
  reviewedVersion?: number
  liveVersion?: number
}
export type EligibilityInput = {
  command: PublishCommand
  batch: ReviewBatch | null
  control: PublishControlState | null
  member: unknown
  liveVersion: number
  receipt: PublishRecord | null
  claim?: { command: PublishCommand; acceptedAt: string; runId?: string }
  claimStop?: PublishStop | null
  ownStop?: PublishStop | null
  receiptStop?: PublishStop | null
  runStatus?: string | null
  now: string
  claimTtlMs?: number
  replay?: boolean
}

export type PublishRunLookup = {
  findRun?: (
    commandId: string
  ) => Promise<{ runId: string; status: string } | null>
  runStatus?: (runId: string) => Promise<string>
}

/**
 * Fingerprint the claim and receipt facts so workflow status can be rechecked against
 * the same evidence.
 */
export const claimRunKey = (
  pending: ReviewBatch['publishCommand'],
  approvalRun: ReviewBatch['approvalRun'],
  claim: EligibilityInput['claim'],
  receipt?: PublishRecord | null
) =>
  JSON.stringify([
    pending ?? null,
    approvalRun ?? null,
    claim ?? null,
    receipt ? [receipt.id, receipt.commandId, receipt.toVersion] : null,
  ])

/**
 * Resolve workflow status by the stored run ID or locate a run from the persisted
 * command.
 */
export async function resolveClaimRun(
  claim: EligibilityInput['claim'],
  lookup: PublishRunLookup
) {
  if (!claim) return { claim, status: undefined }
  try {
    if (claim.runId)
      return {
        claim,
        status: await (lookup.runStatus?.(claim.runId) ??
          Promise.resolve('running')),
      }
    if (!lookup.findRun) return { claim, status: undefined }
    const found = await lookup.findRun(claim.command.commandId!)
    return found
      ? {
          claim: { ...claim, runId: found.runId },
          status: found.status,
          recoveredRunId: found.runId,
        }
      : { claim, status: null }
  } catch {
    return { claim, status: undefined }
  }
}

/**
 * Decide whether a missing, expired or terminal workflow leaves its claim eligible for
 * takeover.
 */
export function claimTakeoverEligible(
  claim: NonNullable<EligibilityInput['claim']>,
  stop: PublishStop | null | undefined,
  status: string | null | undefined,
  now: string,
  ttl = CLAIM_TTL_MS
): boolean {
  const absent = (!claim.runId && status === null) || status === 'not_found'
  const expired =
    absent &&
    Number.isFinite(Date.parse(claim.acceptedAt)) &&
    Date.parse(now) - Date.parse(claim.acceptedAt) >= ttl
  return !!stop || terminalRun(status) || expired
}

/**
 * Explain whether the current command may retry after checking authority, control, batch
 * and receipt state.
 */
export function retryEligibility(input: EligibilityInput): RetryEligibility {
  const { command, batch, control, receipt, liveVersion, claim, now } = input
  /**
   * Construct a retry denial with baseline metadata when it helps the curator recover.
   */
  const denied = (reason: PublishError): RetryEligibility => ({
    canRetry: false,
    reason,
    ...(batch ? { reviewedVersion: batch.baselineVersion, liveVersion } : {}),
  })
  const authority = publishRequesterStop(command.requestedBy, input.member)
  if (authority) return denied(authority)
  const stop = publishControlStop(control, command) ?? input.ownStop
  if (stop) return denied(stop)
  if (!batchApprovedFor(batch, command)) return denied('superseded_revision')
  const baseline = publishBaselineError(
    batch!.baselineVersion,
    liveVersion,
    receipt
  )
  if (baseline) return denied(baseline)
  if (receipt?.committedAt) return denied(PUBLISH_ERRORS.superseded)
  if (claim && claim.command.revision === command.revision) {
    if (input.replay && claim.command.commandId === command.commandId)
      return { canRetry: true, reason: null }
    if (
      !claimTakeoverEligible(
        claim,
        input.claimStop,
        input.runStatus,
        now,
        input.claimTtlMs
      )
    )
      return denied('locked')
    return { canRetry: true, reason: null }
  }
  // A submitted draft can still have a running review for the revision being confirmed.
  const confirmingDraft =
    !input.replay && command.confirmedDraftRevision === command.revision - 1
  const hasApprovalRun =
    !confirmingDraft && batch?.approvalRun?.revision === command.revision - 1
  if (
    input.receiptStop ||
    terminalRun(input.runStatus) ||
    (!hasApprovalRun && !receipt)
  )
    return { canRetry: true, reason: null }
  return denied(PUBLISH_ERRORS.notWaiting)
}
