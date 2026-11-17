import { batchApprovedFor } from './command'
import { publishRequesterStop } from './authority'
import { publishControlStop } from './control'
import { publishBaselineError } from './baseline'
import { PUBLISH_ERRORS } from './stop'
import type { ReviewBatch } from '../review/types'
import type { PublishCommand, PublishControlState, PublishError, PublishRecord, PublishStop } from './types'

export const CLAIM_TTL_MS = 120_000
export const terminalRun = (status?: string | null) => status === 'completed' || status === 'failed' || status === 'cancelled'
export type RetryEligibility = { canRetry: boolean; reason: PublishError | null; reviewedVersion?: number; liveVersion?: number }
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
  findRun?: (commandId: string) => Promise<{ runId: string; status: string } | null>
  runStatus?: (runId: string) => Promise<string>
}

export async function resolveClaimRun(claim: EligibilityInput['claim'], lookup: PublishRunLookup) {
  if (!claim) return { claim, status: undefined }
  if (claim.runId) return { claim, status: await (lookup.runStatus?.(claim.runId) ?? Promise.resolve('running')) }
  if (!lookup.findRun) return { claim, status: undefined }
  const found = await lookup.findRun(claim.command.commandId!)
  return found ? { claim: { ...claim, runId: found.runId }, status: found.status, recoveredRunId: found.runId } : { claim, status: null }
}

export function retryEligibility(input: EligibilityInput): RetryEligibility {
  const { command, batch, control, receipt, liveVersion, claim, now } = input
  const denied = (reason: PublishError): RetryEligibility => ({ canRetry: false, reason, ...(batch ? { reviewedVersion: batch.baselineVersion, liveVersion } : {}) })
  const authority = publishRequesterStop(command.requestedBy, input.member)
  if (authority) return denied(authority)
  const stop = publishControlStop(control, command) ?? input.ownStop
  if (stop) return denied(stop)
  if (!batchApprovedFor(batch, command)) return denied('superseded_revision')
  const baseline = publishBaselineError(batch!.baselineVersion, liveVersion, receipt)
  if (baseline) return denied(baseline)
  if (receipt?.committedAt) return denied(PUBLISH_ERRORS.superseded)
  if (claim && claim.command.revision === command.revision) {
    if (input.replay && claim.command.commandId === command.commandId) return { canRetry: true, reason: null }
    const expired = !claim.runId && input.runStatus === null && Number.isFinite(Date.parse(claim.acceptedAt)) && Date.parse(now) - Date.parse(claim.acceptedAt) >= (input.claimTtlMs ?? CLAIM_TTL_MS)
    if (!input.claimStop && !terminalRun(input.runStatus) && !expired) return denied('locked')
    return { canRetry: true, reason: null }
  }
  if (input.receiptStop || terminalRun(input.runStatus) || batch?.approvalRun?.revision !== command.revision - 1 && !receipt) return { canRetry: true, reason: null }
  return denied(PUBLISH_ERRORS.notWaiting)
}
