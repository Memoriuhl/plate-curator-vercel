import { randomUUID } from 'node:crypto'
import type { Abandonment, AbandonResult, PublishDeps, PublishRecord, RequesterAuthority, SnapshotObject, PublishStop, PublishError } from './types'
import type { ReviewBatch } from '../review/types'
import { claimTakeoverEligible, CLAIM_TTL_MS, type EligibilityInput } from './eligibility'
import { validTarget } from './allocation'
import { publishCommandKey } from './control'

/** Derive a stable archive ID so a retried abandonment finds the same receipt. */
export const abandonedReceiptId = (record: Pick<PublishRecord, 'id' | 'commandId' | 'abandonment'>) => record.abandonment?.receiptId ?? `${record.id}--${record.commandId ?? 'legacy'}`

/**
 * Recover the publish claim from the batch, falling back to its approval run for older
 * records.
 */
export function abandonClaim(batch: ReviewBatch | null, record: PublishRecord, stored: EligibilityInput['claim'], now: string, ttl = CLAIM_TTL_MS): NonNullable<EligibilityInput['claim']> {
  const pending = batch?.publishCommand?.revision === record.revision ? batch.publishCommand : undefined
  return stored ?? {
    command: pending ? { batchId: record.batchId, revision: record.revision, commandId: pending.commandId } : record,
    acceptedAt: new Date(Date.parse(now) - ttl).toISOString(),
    ...(!pending && batch?.approvalRun?.revision === record.revision - 1 ? { runId: batch.approvalRun.runId } : {}),
  }
}

/**
 * Check that the saved receipt and workflow evidence allow abandonment without
 * disturbing the live snapshot.
 */
export function abandonmentError(input: {
  saved: PublishRecord | null; expected: PublishRecord; liveVersion: number; committedTarget: boolean;
  claim: NonNullable<EligibilityInput['claim']>; stop?: PublishStop | null; status?: string | null; now: string; ttl?: number; claimChanged?: boolean
}): PublishError | null {
  const { saved, expected, liveVersion } = input
  if (!saved || saved.batchId !== expected.batchId || saved.revision !== expected.revision || saved.commandId !== expected.commandId || saved.toVersion !== expected.toVersion) return 'superseded'
  if (!Number.isSafeInteger(liveVersion) || liveVersion < 0) return 'unavailable'
  if (saved.committedAt) return 'version_taken'
  if (input.claimChanged || !claimTakeoverEligible(input.claim, input.stop, input.status, input.now, input.ttl)) return 'locked'
  if (input.committedTarget || !validTarget(saved.fromVersion, saved.toVersion)) return 'version_taken'
  return null
}

/**
 * Build the archival plan that records the abandoned receipt and fences all related
 * commands.
 */
export function abandonmentPlan(record: PublishRecord, claim: NonNullable<EligibilityInput['claim']>, actor: RequesterAuthority, reason: string, object: SnapshotObject | null, now: string) {
  const id = abandonedReceiptId(record)
  const disposition: Abandonment = { receiptId: id, commandId: publishCommandKey(record), burnedVersion: record.toVersion, by: actor, at: now, reason, object }
  const archived: PublishRecord = { ...record, id, state: 'abandoned', abandonment: disposition }
  return { disposition, archived, commands: abandonmentCommands(record, claim) }
}

/**
 * Collect the earlier and current commands that must be stopped when a receipt is
 * abandoned.
 */
export const abandonmentCommands = (record: PublishRecord, claim: NonNullable<EligibilityInput['claim']>) => [record, ...record.supersededCommands ?? [], claim.command]

/**
 * Take the publish lease, verify the prepared object and archive its reservation so
 * another publish can proceed.
 */
export async function abandonPreparedSnapshot(d: PublishDeps, actor: RequesterAuthority, record: PublishRecord, reason: string): Promise<AbandonResult> {
  const now = d.now()
  const lease = { batchId: record.batchId, revision: record.revision, purpose: 'abandon' as const, token: randomUUID(), expiresAt: new Date(Date.parse(now) + (d.leaseMs ?? 60000)).toISOString() }
  try {
    if (record.abandonment) return await d.records.abandon(record, actor, reason, record.abandonment.object, '', now)
    if (!await d.lock.claim(lease, now)) return { ok: false, error: 'locked' }
    try {
      const object = await d.snapshots.metadata(record.toVersion)
      return await d.records.abandon(record, actor, reason, object, lease.token, d.now())
    } finally { await d.lock.release(lease.token, false) }
  } catch { return { ok: false, error: 'unavailable' } }
}
