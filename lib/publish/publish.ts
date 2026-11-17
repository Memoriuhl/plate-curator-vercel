import { isPublishStop, PUBLISH_ERRORS } from './stop'
import { isSuperseded, receiptId } from './command'
import { publishBaselineError } from './baseline'
import { randomUUID } from 'node:crypto'
import type { Actor } from '../review/types'
import { sha256, snapshotBytes } from './bytes'
import type { PublishCommand, PublishDeps, PublishError, PublishLease, PublishOutcome, PublishRecord } from './types'
import { validateSnapshot } from './validation'

export async function publishBatch(d: PublishDeps, actor: Actor, command: PublishCommand): Promise<PublishOutcome> {
  if (actor.role !== 'owner') return { ok: false, error: 'forbidden' }
  try {
    return await publishAttempt(d, command)
  } catch {
    return { ok: false, error: PUBLISH_ERRORS.unavailable }
  }
}

async function publishAttempt(d: PublishDeps, command: PublishCommand): Promise<PublishOutcome> {
  const id = receiptId(command.batchId, command.revision)
  const batch = await d.store.getBatch(command.batchId)
  if (!batch) return { ok: false, error: 'not_found' }
  let record = await d.records.get(id)
  if (isSuperseded(record, command)) return { ok: false, error: PUBLISH_ERRORS.superseded }
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
    if (isSuperseded(record, command)) { keepFrozen = false; return { ok: false, error: PUBLISH_ERRORS.superseded } }
    if (!record?.committedAt) {
      const stop = await d.control.check(command, d.now())
      if (stop) { keepFrozen = false; return { ok: false, error: stop } }
    }
    const liveVersion = record?.committedAt ? record.fromVersion : (await d.pointer.read()).version
    const baselineError = publishBaselineError(batch.baselineVersion, liveVersion, record)
    if (baselineError) {
      keepFrozen = false
      return { ok: false, error: baselineError, reviewedVersion: batch.baselineVersion, liveVersion }
    }
    if (record && record.commandId !== command.commandId) {
      if (record.committedAt) { keepFrozen = false; return { ok: false, error: PUBLISH_ERRORS.superseded } }
      const checksum = await d.snapshots.checksum(record.toVersion)
      if (checksum !== null) {
        const adopted = await d.records.adopt(record, command, checksum, lease.token, d.now())
        if (typeof adopted === 'string') { keepFrozen = false; return { ok: false, error: adopted } }
        record = adopted
      }
    }
    if (record?.state === 'failed' && record.commandId === command.commandId) {
      keepFrozen = false
      return { ok: false, error: record.failure ?? 'invalid_state' }
    }
    if (!await renew()) return { ok: false, error: 'lock_lost' }
    let existingChecksum = record ? await d.snapshots.checksum(record.toVersion) : null
    if (record && existingChecksum !== null && existingChecksum !== record.blobSha256) return await fail('version_taken')
    if (record?.committedAt && existingChecksum === null) return { ok: false, error: PUBLISH_ERRORS.unavailable }
    if (!record || existingChecksum === null) {
      const fromVersion = record?.fromVersion ?? liveVersion
      const baseline = await d.snapshots.read(fromVersion)
      if (!baseline || baseline.version !== fromVersion || !Array.isArray(baseline.plates) || baseline.plates.some(plate => !plate || typeof plate !== 'object')) {
        keepFrozen = false
        return { ok: false, error: 'invalid_snapshot', reasons: ['Baseline snapshot has an invalid version or plates'] }
      }
      const edits = await d.store.listEdits(command.batchId)
      const fields = new Map(edits.map(edit => [edit.plateId, edit.fields]))
      const orders = new Map(Object.entries(batch.stateOrders).map(([state, order]) => [state, new Map(order.map((id, index) => [id, index]))]))
      const next = { version: fromVersion + 1, plates: baseline.plates.map(plate => {
        const edited = { ...plate, ...fields.get(plate.id) }
        if (fields.get(plate.id)?.variantOfPlateId === null) delete edited.variantOfPlateId
        const order = orders.get(plate.state)
        if (order) edited.sortOrder = order.get(plate.id)
        return edited
      }) }
      const reasons = validateSnapshot(baseline, next)
      for (const [state, order] of Object.entries(batch.stateOrders)) {
        const ids = new Set(baseline.plates.filter(plate => plate.state === state).map(plate => plate.id))
        if (order.length !== ids.size || new Set(order).size !== order.length || order.some(id => !ids.has(id))) {
          reasons.push(`State order for ${state} must list exactly its baseline plates, without duplicates or extras`)
        }
      }
      for (const edit of edits) {
        if (!batch.plateIds.includes(edit.plateId) || !baseline.plates.some(plate => plate.id === edit.plateId)) reasons.push(`Edit references a missing batch plate: ${edit.plateId}`)
      }
      if (reasons.length > 0) {
        keepFrozen = false
        return { ok: false, error: 'invalid_snapshot', reasons }
      }
      const bytes = snapshotBytes(next)
      const checksum = sha256(bytes)
      if (record && record.blobSha256 !== checksum) { keepFrozen = false; return { ok: false, error: 'version_taken' } }
      if (record && record.commandId !== command.commandId) {
        const adopted = await d.records.adopt(record, command, checksum, lease.token, d.now())
        if (typeof adopted === 'string') { keepFrozen = false; return { ok: false, error: adopted } }
        record = adopted
      }
      record ??= { id, ...command, fromVersion, toVersion: fromVersion + 1, blobSha256: checksum, state: 'started' }
      if (!await d.records.save(record, lease.token, d.now()) || !await renew()) return { ok: false, error: 'lock_lost' }
      const uploadStop = await d.records.checkUpload(record, command, checksum, lease.token, d.now())
      if (uploadStop) { keepFrozen = false; return { ok: false, error: uploadStop } }
      await d.snapshots.createOnly(record.toVersion, bytes)
      existingChecksum = await d.snapshots.checksum(record.toVersion)
      if (existingChecksum !== record.blobSha256) return await fail('version_taken')
    }
    if (!await renew()) return { ok: false, error: 'lock_lost' }
    if (!record.committedAt) {
      const object = await d.snapshots.metadata(record.toVersion)
      if (!object) return { ok: false, error: PUBLISH_ERRORS.unavailable }
      if (await d.snapshots.checksum(record.toVersion, object.generation) !== record.blobSha256) return await fail('version_taken')
      record = { ...record, url: object.url, object, state: 'uploaded' }
      if (!await d.records.save(record, lease.token, d.now())) return { ok: false, error: 'lock_lost' }
      const advanced = await d.pointer.advance(record, lease, d.now())
      if (isPublishStop(advanced)) {
        keepFrozen = false
        return { ok: false, error: advanced }
      }
      if (advanced !== 'advanced') return advanced === 'lock_lost' ? { ok: false, error: 'lock_lost' } : await fail(advanced)
      record = await d.records.get(id)
      if (!record?.committedAt) return { ok: false, error: PUBLISH_ERRORS.unavailable }
    }
    if (await d.curator.writeStateOrders(batch.stateOrders, lease, d.now()) !== 'ok') return { ok: false, error: 'lock_lost' }
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
