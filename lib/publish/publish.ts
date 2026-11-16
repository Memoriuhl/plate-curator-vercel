import { randomUUID } from 'node:crypto'
import type { Actor } from '../review/types'
import { sha256, snapshotBytes } from './bytes'
import type { PublishDeps, PublishError, PublishLease, PublishOutcome, PublishRecord } from './types'
import { validateSnapshot } from './validation'

export async function publishBatch(d: PublishDeps, actor: Actor, command: { batchId: string; revision: number }): Promise<PublishOutcome> {
  if (actor.role !== 'owner') return { ok: false, error: 'forbidden' }
  try {
    return await publishAttempt(d, command)
  } catch {
    return { ok: false, error: 'unavailable' }
  }
}

async function publishAttempt(d: PublishDeps, command: { batchId: string; revision: number }): Promise<PublishOutcome> {
  const id = `${command.batchId}@${command.revision}`
  const batch = await d.store.getBatch(command.batchId)
  if (!batch) return { ok: false, error: 'not_found' }
  let record = await d.records.get(id)
  if (record?.state === 'done' && record.committedAt && batch.state === 'published' && batch.revision === command.revision + 1) {
    if (record.completionToken) await d.lock.release(record.completionToken, false)
    return { ok: true, value: record }
  }
  if (batch.revision !== command.revision) return { ok: false, error: 'superseded_revision' }
  if (batch.state !== 'approved') return { ok: false, error: 'invalid_state' }
  const leaseMs = d.leaseMs ?? 60000
  const expiry = () => new Date(Date.parse(d.now()) + leaseMs).toISOString()
  const lease: PublishLease = { ...command, token: randomUUID(), expiresAt: expiry() }
  if (!await d.lock.claim(lease, d.now())) return { ok: false, error: 'locked' }
  let keepFrozen = true
  const renew = async () => {
    lease.expiresAt = expiry()
    return d.lock.renew(lease, d.now())
  }
  const fail = async (error: PublishError): Promise<PublishOutcome> => {
    keepFrozen = false
    if (record && !await d.records.save({ ...record, state: 'failed', failure: error }, lease.token, d.now())) return { ok: false, error: 'lock_lost' }
    return { ok: false, error }
  }
  try {
    record = await d.records.get(id)
    if (record?.state === 'failed') {
      keepFrozen = false
      return { ok: false, error: record.failure ?? 'invalid_state' }
    }
    if (!await renew()) return { ok: false, error: 'lock_lost' }
    let existingChecksum = record ? await d.snapshots.checksum(record.toVersion) : null
    if (record && existingChecksum !== null && existingChecksum !== record.blobSha256) return await fail('version_taken')
    if (record?.committedAt && existingChecksum === null) return { ok: false, error: 'unavailable' }
    if (!record || existingChecksum === null) {
      const fromVersion = record?.fromVersion ?? (await d.pointer.read()).version
      const baseline = await d.snapshots.read(fromVersion)
      if (!baseline || baseline.version !== fromVersion || !Array.isArray(baseline.plates) || baseline.plates.some(plate => !plate || typeof plate !== 'object')) {
        keepFrozen = false
        return { ok: false, error: 'invalid_snapshot', reasons: ['Baseline snapshot has an invalid version or plates'] }
      }
      const edits = await d.store.listEdits(command.batchId)
      const fields = new Map(edits.map(edit => [edit.plateId, edit.fields]))
      const next = { version: fromVersion + 1, plates: baseline.plates.map(plate => ({ ...plate, ...fields.get(plate.id) })) }
      const reasons = validateSnapshot(baseline, next)
      for (const edit of edits) {
        if (!batch.plateIds.includes(edit.plateId) || !baseline.plates.some(plate => plate.id === edit.plateId)) reasons.push(`Edit references a missing batch plate: ${edit.plateId}`)
      }
      if (reasons.length > 0) {
        keepFrozen = false
        return { ok: false, error: 'invalid_snapshot', reasons }
      }
      const bytes = snapshotBytes(next)
      const checksum = sha256(bytes)
      if (record && record.blobSha256 !== checksum) return await fail('version_taken')
      record ??= { id, ...command, fromVersion, toVersion: fromVersion + 1, blobSha256: checksum, state: 'started' }
      if (!await d.records.save(record, lease.token, d.now()) || !await renew()) return { ok: false, error: 'lock_lost' }
      await d.snapshots.createOnly(record.toVersion, bytes)
      existingChecksum = await d.snapshots.checksum(record.toVersion)
      if (existingChecksum !== record.blobSha256) return await fail('version_taken')
    }
    if (!await renew()) return { ok: false, error: 'lock_lost' }
    if (!record.committedAt) {
      const url = record.url ?? await d.snapshots.downloadUrl(record.toVersion)
      if (!url) return { ok: false, error: 'unavailable' }
      record = { ...record, url, state: 'uploaded' }
      if (!await d.records.save(record, lease.token, d.now())) return { ok: false, error: 'lock_lost' }
      const advanced = await d.pointer.advance(record, lease, d.now())
      if (advanced !== 'advanced') return advanced === 'lock_lost' ? { ok: false, error: 'lock_lost' } : await fail(advanced)
      record = await d.records.get(id)
      if (!record?.committedAt) return { ok: false, error: 'unavailable' }
    }
    const done: PublishRecord = { ...record, state: 'done', completionToken: lease.token }
    if (!await d.records.save(done, lease.token, d.now()) || !await renew()) return { ok: false, error: 'lock_lost' }
    const committed = await d.store.commit(batch.id, command.revision, {
      batch: { ...batch, state: 'published', revision: command.revision + 1 }, publishToken: lease.token,
    })
    if (committed !== 'ok') return { ok: false, error: 'superseded_revision' }
    keepFrozen = false
    return { ok: true, value: done }
  } finally {
    await d.lock.release(lease.token, keepFrozen)
  }
}
