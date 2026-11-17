import { randomUUID } from 'node:crypto'
import type { AbandonResult, PublishDeps, PublishRecord, RequesterAuthority } from './types'

export const abandonedReceiptId = (record: Pick<PublishRecord, 'id' | 'commandId' | 'abandonment'>) => record.abandonment?.receiptId ?? `${record.id}--${record.commandId ?? 'legacy'}`

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
