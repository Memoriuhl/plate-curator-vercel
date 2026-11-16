import type { Snapshot } from '../catalog/types'
import type { ReviewDeps } from '../review/types'

export type CatalogPointer = { version: number; url?: string; blobSha256?: string; publishedAt?: string }
export type PublishError = 'forbidden' | 'not_found' | 'invalid_state' | 'superseded_revision' | 'invalid_snapshot' | 'locked' | 'lock_lost' | 'version_taken' | 'pointer_moved' | 'unavailable'
export type PublishRecord = {
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
  advance(record: PublishRecord, lease: PublishLease, now: string): Promise<'advanced' | 'pointer_moved' | 'lock_lost' | 'superseded_revision'>
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
  curator: PublishCurator
  pointer: PublishPointer
  snapshots: PublishSnapshots
  records: PublishRecords
  lock: PublishLock
  leaseMs?: number
}
export type PublishOutcome = { ok: true; value: PublishRecord } | { ok: false; error: PublishError; reasons?: string[] }
