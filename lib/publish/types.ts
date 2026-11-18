import type { BaselineError } from './baseline'
import type { PIPELINE_BUSY, PublishStop } from './stop'
import type { Snapshot } from '../catalog/types'
import type { ReviewDeps } from '../review/types'
import type { RetryEligibility } from './eligibility'

export type CatalogPointer = { version: number; url?: string; blobSha256?: string; publishedAt?: string }
export type { PublishStop } from './stop'
export type RequesterAuthority = { uid: string; email: string; authorityEpoch: number }
export type PublishRequester = { ownerUid: string; requestedBy?: RequesterAuthority; generation?: number; commandId?: string }
export type PublishCommand = { batchId: string; revision: number; confirmedDraftRevision?: number } & Omit<PublishRequester, 'ownerUid'>
/** Validate command IDs before they enter persisted keys and release requests. */
export const validCommandId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value)
export type PublishControlState = { paused: boolean; generation: number; changedBy: { uid: string; email: string }; changedAt: string }
export interface PublishControl {
  read(): Promise<PublishControlState | null>
  check(command: PublishCommand, now: string): Promise<PublishStop | null>
}
export type PublishError = PublishStop | typeof PIPELINE_BUSY | 'empty_batch' | 'not_waiting' | 'forbidden' | 'not_found' | 'invalid_state' | 'superseded_revision' | 'invalid_snapshot' | 'locked' | 'lock_lost' | 'version_taken' | 'pointer_moved' | 'unavailable' | BaselineError
export type PublishRecord = {
  abandonment?: Abandonment
  object?: SnapshotObject
  supersededCommands?: PublishCommand[]
  requestedBy?: RequesterAuthority
  generation?: number
  commandId?: string
  id: string
  batchId: string
  revision: number
  fromVersion: number
  toVersion: number
  blobSha256: string
  url?: string
  state: 'started' | 'uploaded' | 'done' | 'failed' | 'abandoned'
  committedAt?: string
  completionToken?: string
  failure?: PublishError
}
export type PublishLease = { token: string; batchId: string; revision: number; expiresAt: string; purpose?: 'abandon' }
export interface PublishPointer {
  read(): Promise<CatalogPointer>
  advance(record: PublishRecord, lease: PublishLease, now: string): Promise<'advanced' | 'version_taken' | 'pointer_moved' | 'lock_lost' | 'superseded_revision' | PublishStop | typeof PIPELINE_BUSY>
}
export type SnapshotObject = { generation: string; metageneration: string; md5Hash?: string; crc32c?: string; url: string }
export interface PublishSnapshots {
  metadata(version: number): Promise<SnapshotObject | null>
  read(version: number): Promise<Snapshot>
  createOnly(version: number, bytes: Uint8Array): Promise<'created' | 'exists'>
  checksum(version: number, generation?: string): Promise<string | null>
  downloadUrl(version: number): Promise<string | null>
}
export interface PublishRecords {
  pipelineBusy?(): Promise<boolean>
  nextVersion(token: string, now: string): Promise<number | null>
  abandon(record: PublishRecord, actor: RequesterAuthority, reason: string, object: SnapshotObject | null, token: string, now: string): Promise<AbandonResult>
  abandonmentEligibility(record: PublishRecord, now: string): Promise<PublishError | null>
  checkUpload(record: PublishRecord, command: PublishCommand, checksum: string, token: string, now: string): Promise<PublishError | null>
  eligibility(command: PublishCommand, now: string): Promise<RetryEligibility>
  command(commandId: string): Promise<{ command: PublishCommand; runId?: string } | null>
  accept(command: PublishCommand, now: string): Promise<{ ok: true; command: PublishCommand; runId?: string } | { ok: false; error: PublishError }>
  bindRun(command: PublishCommand, runId: string, now: string): Promise<boolean>
  stopped(record: PublishCommand): Promise<PublishStop | null>
  adopt(record: PublishRecord, command: PublishCommand, checksum: string | null, token: string, now: string): Promise<PublishRecord | PublishError>
  get(id: string): Promise<PublishRecord | null>
  save(record: PublishRecord, token: string, now: string): Promise<boolean>
}
export type Abandonment = { receiptId: string; commandId: string; burnedVersion: number; by: RequesterAuthority; at: string; reason: string; object: SnapshotObject | null }
export type AbandonResult = { ok: true; value: Abandonment } | { ok: false; error: PublishError }
export interface PublishLock {
  claim(lease: PublishLease, now: string): Promise<boolean>
  renew(lease: PublishLease, now: string): Promise<boolean>
  release(token: string, keepBatchFrozen: boolean): Promise<void>
}
export type CommittedStateOrders = { version: number; blobSha256: string; orders: Record<string, string[]> }
export interface PublishCurator {
  writeStateOrders(orders: Record<string, string[]>, lease: PublishLease, now: string, record: PublishRecord, live?: CommittedStateOrders): Promise<'ok' | 'lock_lost' | 'reconcile' | 'unavailable'>
}
export type PublishDeps = ReviewDeps & {
  control: PublishControl
  curator: PublishCurator
  pointer: PublishPointer
  snapshots: PublishSnapshots
  records: PublishRecords
  lock: PublishLock
  leaseMs?: number
}
export type PublishOutcome = { ok: true; value: PublishRecord } | { ok: false; error: PublishError; reasons?: string[]; reviewedVersion?: number; liveVersion?: number }
