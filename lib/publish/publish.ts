import { isPublishStop, PIPELINE_BUSY, PUBLISH_ERRORS } from './stop'
import { claimSupersedes, isSuperseded, receiptId } from './command'
import { publishBaselineError } from './baseline'
import { randomUUID } from 'node:crypto'
import type { Actor } from '../review/types'
import { sha256, snapshotBytes } from './bytes'
import type {
  CommittedStateOrders,
  PublishCommand,
  PublishDeps,
  PublishError,
  PublishLease,
  PublishOutcome,
  PublishRecord,
} from './types'
import { applyReleaseEdits } from './apply-edits'
import { validateSnapshot } from './validation'
import { orderedStatePlates } from '../catalog/order'

/**
 * Authorize an owner to run the release attempt and translate unexpected failures into a
 * publish outcome.
 */
export async function publishBatch(
  d: PublishDeps,
  actor: Actor,
  command: PublishCommand
): Promise<PublishOutcome> {
  if (actor.role !== 'owner') return { ok: false, error: 'forbidden' }
  try {
    return await publishAttempt(d, command)
  } catch {
    return { ok: false, error: PUBLISH_ERRORS.unavailable }
  }
}

/**
 * Prepare, verify and commit a snapshot under its publish lease, resuming from persisted
 * receipt progress.
 */
async function publishAttempt(
  d: PublishDeps,
  command: PublishCommand
): Promise<PublishOutcome> {
  const id = receiptId(command.batchId, command.revision)
  const batch = await d.store.getBatch(command.batchId)
  if (!batch) return { ok: false, error: 'not_found' }
  let record = await d.records.get(id)
  if (claimSupersedes(batch, command))
    return { ok: false, error: PUBLISH_ERRORS.superseded }
  if (!record) {
    const stopped = await d.records.stopped(command)
    if (stopped) return { ok: false, error: stopped }
  }
  if (isSuperseded(record, command))
    return { ok: false, error: PUBLISH_ERRORS.superseded }
  if (
    record?.state === 'done' &&
    record.committedAt &&
    batch.state === 'published' &&
    batch.revision === command.revision + 1
  ) {
    if (record.completionToken)
      await d.lock.release(record.completionToken, false)
    return { ok: true, value: record }
  }
  if (batch.revision !== command.revision)
    return { ok: false, error: 'superseded_revision' }
  if (batch.state !== 'approved') return { ok: false, error: 'invalid_state' }
  const leaseMs = d.leaseMs ?? 60000
  /** Set a fresh lease deadline using the publish clock. */
  const expiry = () => new Date(Date.parse(d.now()) + leaseMs).toISOString()
  const lease: PublishLease = {
    ...command,
    token: randomUUID(),
    expiresAt: expiry(),
  }
  if (!(await d.lock.claim(lease, d.now())))
    return {
      ok: false,
      error: (await d.records.pipelineBusy?.()) ? PIPELINE_BUSY : 'locked',
    }
  let keepFrozen = true
  /** Renew the current lease before continuing release work. */
  const renew = async () => {
    lease.expiresAt = expiry()
    return d.lock.renew(lease, d.now())
  }
  /**
   * Record a failed attempt and release the freeze when this attempt can no longer
   * advance.
   */
  const fail = async (error: PublishError): Promise<PublishOutcome> => {
    keepFrozen = false
    if (
      record &&
      !(await d.records.save(
        { ...record, state: 'failed', failure: error },
        lease.token,
        d.now()
      ))
    )
      return { ok: false, error: 'lock_lost' }
    return { ok: false, error }
  }
  try {
    record = await d.records.get(id)
    if (isSuperseded(record, command)) {
      keepFrozen = false
      return { ok: false, error: PUBLISH_ERRORS.superseded }
    }
    if (!record?.committedAt) {
      const stop = await d.control.check(command, d.now())
      if (stop) {
        keepFrozen = false
        return { ok: false, error: stop }
      }
    }
    const liveVersion = record?.committedAt
      ? record.fromVersion
      : (await d.pointer.read()).version
    const baselineError = publishBaselineError(
      batch.baselineVersion,
      liveVersion,
      record
    )
    if (baselineError) {
      keepFrozen = false
      return {
        ok: false,
        error: baselineError,
        reviewedVersion: batch.baselineVersion,
        liveVersion,
      }
    }
    if (record && record.commandId !== command.commandId) {
      if (record.committedAt) {
        keepFrozen = false
        return { ok: false, error: PUBLISH_ERRORS.superseded }
      }
      const checksum = await d.snapshots.checksum(record.toVersion)
      if (checksum !== null) {
        const adopted = await d.records.adopt(
          record,
          command,
          checksum,
          lease.token,
          d.now()
        )
        if (typeof adopted === 'string') {
          keepFrozen = false
          return { ok: false, error: adopted }
        }
        record = adopted
      }
    }
    if (record?.state === 'failed' && record.commandId === command.commandId) {
      keepFrozen = false
      return { ok: false, error: record.failure ?? 'invalid_state' }
    }
    if (!(await renew())) return { ok: false, error: 'lock_lost' }
    let existingChecksum = record
      ? await d.snapshots.checksum(record.toVersion)
      : null
    if (
      record &&
      existingChecksum !== null &&
      existingChecksum !== record.blobSha256
    )
      return await fail('version_taken')
    if (record?.committedAt && existingChecksum === null)
      return { ok: false, error: PUBLISH_ERRORS.unavailable }
    if (!record || existingChecksum === null) {
      const fromVersion = record?.fromVersion ?? liveVersion
      const baseline = await d.snapshots.read(fromVersion)
      if (
        !baseline ||
        baseline.version !== fromVersion ||
        !Array.isArray(baseline.plates) ||
        baseline.plates.some((plate) => !plate || typeof plate !== 'object')
      ) {
        keepFrozen = false
        return {
          ok: false,
          error: 'invalid_snapshot',
          reasons: ['Baseline snapshot has an invalid version or plates'],
        }
      }
      const edits = (await d.store.listEdits(command.batchId)).filter(
        (edit) => Object.keys(edit.fields).length > 0
      )
      const toVersion =
        record?.toVersion ?? (await d.records.nextVersion(lease.token, d.now()))
      if (toVersion === null) return { ok: false, error: 'lock_lost' }
      const { deleted, plates } = applyReleaseEdits(
        baseline.plates,
        edits,
        batch.stateOrders
      )
      const next = { version: toVersion, plates }
      const reasons = validateSnapshot(
        baseline,
        next,
        deleted,
        batch.stateOrders,
        batch.baselineOrders
      )
      for (const [state, order] of Object.entries(batch.stateOrders)) {
        const ids = new Set(
          baseline.plates
            .filter((plate) => plate.state === state)
            .map((plate) => plate.id)
        )
        if (
          order.length !== ids.size ||
          new Set(order).size !== order.length ||
          order.some((id) => !ids.has(id))
        ) {
          reasons.push(
            `State order for ${state} must list exactly its baseline plates, without duplicates or extras`
          )
        }
      }
      for (const edit of edits) {
        if (
          !batch.plateIds.includes(edit.plateId) ||
          !baseline.plates.some((plate) => plate.id === edit.plateId)
        )
          reasons.push(`Edit references a missing batch plate: ${edit.plateId}`)
      }
      if (reasons.length > 0) {
        keepFrozen = false
        return { ok: false, error: 'invalid_snapshot', reasons }
      }
      const bytes = snapshotBytes(next)
      const checksum = sha256(bytes)
      if (record && record.blobSha256 !== checksum) {
        keepFrozen = false
        return { ok: false, error: 'version_taken' }
      }
      if (record && record.commandId !== command.commandId) {
        const adopted = await d.records.adopt(
          record,
          command,
          checksum,
          lease.token,
          d.now()
        )
        if (typeof adopted === 'string') {
          keepFrozen = false
          return { ok: false, error: adopted }
        }
        record = adopted
      }
      record ??= {
        id,
        ...command,
        fromVersion,
        toVersion,
        blobSha256: checksum,
        state: 'started',
      }
      if (
        !(await d.records.save(record, lease.token, d.now())) ||
        !(await renew())
      )
        return { ok: false, error: 'lock_lost' }
      const uploadStop = await d.records.checkUpload(
        record,
        command,
        checksum,
        lease.token,
        d.now()
      )
      if (uploadStop) {
        keepFrozen = false
        return { ok: false, error: uploadStop }
      }
      await d.snapshots.createOnly(record.toVersion, bytes)
      existingChecksum = await d.snapshots.checksum(record.toVersion)
      if (existingChecksum !== record.blobSha256)
        return await fail('version_taken')
    }
    if (!(await renew())) return { ok: false, error: 'lock_lost' }
    if (!record.committedAt) {
      const object = await d.snapshots.metadata(record.toVersion)
      if (!object) return { ok: false, error: PUBLISH_ERRORS.unavailable }
      if (
        (await d.snapshots.checksum(record.toVersion, object.generation)) !==
        record.blobSha256
      )
        return await fail('version_taken')
      record = { ...record, url: object.url, object, state: 'uploaded' }
      if (!(await d.records.save(record, lease.token, d.now())))
        return { ok: false, error: 'lock_lost' }
      const advanced = await d.pointer.advance(record, lease, d.now())
      if (isPublishStop(advanced)) {
        keepFrozen = false
        return { ok: false, error: advanced }
      }
      if (advanced !== 'advanced')
        return advanced === 'lock_lost'
          ? { ok: false, error: 'lock_lost' }
          : await fail(advanced)
      record = await d.records.get(id)
      if (!record?.committedAt)
        return { ok: false, error: PUBLISH_ERRORS.unavailable }
    }
    let orderResult = await d.curator.writeStateOrders(
      batch.stateOrders,
      lease,
      d.now(),
      record
    )
    for (
      let attempt = 0;
      orderResult === 'reconcile' && attempt < 3;
      attempt++
    ) {
      let live
      try {
        live = await committedStateOrders(
          d,
          Object.keys(batch.stateOrders),
          record.toVersion
        )
      } catch {
        continue
      }
      if (!live) continue
      if (!(await renew())) return { ok: false, error: 'lock_lost' }
      orderResult = await d.curator.writeStateOrders(
        batch.stateOrders,
        lease,
        d.now(),
        record,
        live
      )
    }
    if (orderResult !== 'ok')
      return {
        ok: false,
        error: orderResult === 'reconcile' ? 'unavailable' : orderResult,
      }
    const done: PublishRecord = {
      ...record,
      state: 'done',
      completionToken: lease.token,
    }
    if (!(await d.records.save(done, lease.token, d.now())) || !(await renew()))
      return { ok: false, error: 'lock_lost' }
    const committed = await d.store.commit(batch.id, command.revision, {
      batch: { ...batch, state: 'published', revision: command.revision + 1 },
      publishToken: lease.token,
    })
    if (committed !== 'ok') return { ok: false, error: 'superseded_revision' }
    keepFrozen = false
    return { ok: true, value: done }
  } finally {
    await d.lock.release(lease.token, keepFrozen)
  }
}

/**
 * Recover committed state orders from the verified live snapshot for curator projection.
 */
async function committedStateOrders(
  d: PublishDeps,
  states: string[],
  toVersion: number
): Promise<CommittedStateOrders | null> {
  const pointer = await d.pointer.read()
  if (
    !Number.isSafeInteger(pointer.version) ||
    pointer.version <= toVersion ||
    typeof pointer.blobSha256 !== 'string'
  )
    return null
  const snapshot = await d.snapshots.read(pointer.version)
  if (snapshot.version !== pointer.version || !Array.isArray(snapshot.plates))
    return null
  if (
    snapshot.plates.some(
      (plate) =>
        !plate ||
        typeof plate.id !== 'string' ||
        typeof plate.state !== 'string' ||
        (plate.sortOrder !== undefined &&
          (typeof plate.sortOrder !== 'number' ||
            !Number.isFinite(plate.sortOrder)))
    )
  )
    return null
  if (
    new Set(snapshot.plates.map((plate) => plate.id)).size !==
    snapshot.plates.length
  )
    return null
  if (
    sha256(snapshotBytes(snapshot)) !== pointer.blobSha256 ||
    (await d.snapshots.checksum(pointer.version)) !== pointer.blobSha256
  )
    return null
  return {
    version: pointer.version,
    blobSha256: pointer.blobSha256,
    orders: Object.fromEntries(
      states.map((state) => [
        state,
        orderedStatePlates(snapshot, state, {
          stateOrder: {},
          stateProgress: {},
        }).map((plate) => plate.id),
      ])
    ),
  }
}
