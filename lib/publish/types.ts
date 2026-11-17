import type { BaselineError } from './baseline'
import type { PublishStop } from './stop'
import type { Snapshot } from '../catalog/types'
import type { ReviewDeps } from '../review/types'

export type CatalogPointer = { version: number; url?: string; blobSha256?: string; publishedAt?: string }
export type { PublishStop } from './stop'
export type PublishRequester = { ownerUid: string; generation?: number; commandId?: string }
export type PublishCommand = { batchId: string; revision: number } & Omit<PublishRequester, 'ownerUid'>
export type PublishControlState = { paused: boolean; generation: number; changedBy: { uid: string; email: string }; changedAt: string }
export interface PublishControl {
  read(): Promise<PublishControlState | null>
  check(command: PublishCommand, now: string): Promise<PublishStop | null>
}
export type PublishError = PublishStop | 'forbidden' | 'not_found' | 'invalid_state' | 'superseded_revision' | 'invalid_snapshot' | 'locked' | 'lock_lost' | 'version_taken' | 'pointer_moved' | 'unavailable' | BaselineError
export type PublishRecord = {
  generation?: number
  commandId?: string
  id: string
  batchId: string
  revision: number
  fromVersion: number
  toVersion: number
  blobSha256: string
  url?: string
  state: 'started' | 'uploaded' | 'done' | 'failed'
  committedAt?: string
  completionToken?: string
  failure?: PublishError
}
export type PublishLease = { token: string; batchId: string; revision: number; expiresAt: string }
export interface PublishPointer {
  read(): Promise<CatalogPointer>
  advance(record: PublishRecord, lease: PublishLease, now: string): Promise<'advanced' | 'pointer_moved' | 'lock_lost' | 'superseded_revision' | PublishStop>
}
export interface PublishSnapshots {
  read(version: number): Promise<Snapshot>
  createOnly(version: number, bytes: Uint8Array): Promise<'created' | 'exists'>
  checksum(version: number): Promise<string | null>
  downloadUrl(version: number): Promise<string | null>
}
export interface PublishRecords {
  get(id: string): Promise<PublishRecord | null>
  save(record: PublishRecord, token: string, now: string): Promise<boolean>
}
export interface PublishLock {
  claim(lease: PublishLease, now: string): Promise<boolean>
  renew(lease: PublishLease, now: string): Promise<boolean>
  release(token: string, keepBatchFrozen: boolean): Promise<void>
}
export interface PublishCurator {
  writeStateOrders(orders: Record<string, string[]>, lease: PublishLease, now: string): Promise<'ok' | 'lock_lost'>
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
