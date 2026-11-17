import { publishRequesterStop, sameRequester } from './authority'
import { isActiveOwner, normalizeEmail } from '../members/member'
import { isPublishStop, PUBLISH_STOPS, type PublishStop } from './stop'
import { parsePublishControl, publishCommandKey, publishControlStop } from './control'
import type { PublishCommand, PublishControl, PublishControlState } from './types'
import { FieldValue, type DocumentData, type DocumentSnapshot, type Transaction, type Firestore } from '@google-cloud/firestore'
import type { PublishCurator, PublishLock, PublishPointer, PublishRecord, PublishRecords } from './types'

function memberDocRef(db: Firestore, email: string | undefined) {
  return email ? db.doc(`members/${encodeURIComponent(normalizeEmail(email))}`) : null
}

function writePublishStop({ transaction, command, control, stopped, now, member }: {
  transaction: Transaction; command: PublishCommand; control: DocumentSnapshot; stopped: DocumentSnapshot; now: string; member?: DocumentSnapshot
}): PublishStop | null {
  const reason: unknown = stopped.get('reason') ?? publishControlStop(parsePublishControl(control.data()), command) ?? publishRequesterStop(command.requestedBy, member?.data())
  if (reason === null) return null
  if (!isPublishStop(reason)) throw new Error('Malformed Publish stop')
  if (!stopped.exists) transaction.set(stopped.ref, { ...command, reason, stoppedAt: now })
  return reason
}

function unexpired(expiresAt: unknown, now: string): boolean {
  return typeof expiresAt === 'string' && Date.parse(expiresAt) > Date.parse(now)
}

function active(data: DocumentData | undefined, token: string, env: string, now: string): boolean {
  return data?.token === token && data.env === env && unexpired(data.expiresAt, now)
}

export function firestorePublishLock(db: Firestore, env: string): PublishLock {
  const lockRef = db.doc('locks/publish')
  return {
    async claim(lease, now) {
      if (!unexpired(lease.expiresAt, now)) return false
      return db.runTransaction(async transaction => {
        const batchRef = db.doc(`reviewBatches/${lease.batchId}`)
        const [lock, batch] = await transaction.getAll(lockRef, batchRef)
        if (lock.exists && unexpired(lock.get('expiresAt'), now)) return false
        const data = batch.data()
        const recordId = `${lease.batchId}@${lease.revision}`
        if (data?.env !== env || data.state !== 'approved' || data.revision !== lease.revision) return false
        if (data.publishReservation && data.publishReservation.recordId !== recordId) return false
        transaction.set(lockRef, { ...lease, env })
        transaction.update(batchRef, { publishReservation: { recordId, token: lease.token } })
        return true
      })
    },
    async renew(lease, now) {
      return db.runTransaction(async transaction => {
        const lock = await transaction.get(lockRef)
        if (!active(lock.data(), lease.token, env, now) || !unexpired(lease.expiresAt, now)) return false
        if (lock.get('batchId') !== lease.batchId || lock.get('revision') !== lease.revision) return false
        transaction.update(lockRef, { expiresAt: lease.expiresAt })
        return true
      })
    },
    async release(token, keepBatchFrozen) {
      await db.runTransaction(async transaction => {
        const lock = await transaction.get(lockRef)
        if (lock.get('token') !== token || lock.get('env') !== env) return
        const batchRef = db.doc(`reviewBatches/${lock.get('batchId')}`)
        const batch = await transaction.get(batchRef)
        if (!keepBatchFrozen && batch.get('publishReservation')?.token === token) {
          transaction.update(batchRef, { publishReservation: FieldValue.delete() })
        }
        transaction.delete(lockRef)
      })
    },
  }
}

export function firestorePublishRecords(db: Firestore, env: string): PublishRecords {
  return {
    async command(commandId) {
      const saved = await db.doc(`publishCommands/${commandId}`).get()
      return saved.get('env') === env ? { command: saved.get('command') as PublishCommand, ...(saved.get('runId') ? { runId: saved.get('runId') as string } : {}) } : null
    },
    async stopped(command) {
      const reason: unknown = (await db.doc(`publishCommandStops/${publishCommandKey(command)}`).get()).get('reason')
      return isPublishStop(reason) ? reason : null
    },
    async accept(command, now) {
      return db.runTransaction(async transaction => {
        const ref = db.doc(`publishCommands/${publishCommandKey(command)}`)
        const requesterRef = memberDocRef(db, command.requestedBy?.email)
        const [accepted, batch, pointer, receipt, control, member] = await transaction.getAll(ref,
          db.doc(`reviewBatches/${command.batchId}`), db.doc('config/catalog'), db.doc(`publishRecords/${command.batchId}@${command.revision}`),
          db.doc('config/publishControl'), ...(requesterRef ? [requesterRef] : []))
        if (accepted.exists) {
          const data = accepted.data()!
          if (data.env !== env || data.command.batchId !== command.batchId || data.command.revision !== command.revision || !sameRequester(data.command.requestedBy, command.requestedBy)) return 'superseded'
          return { command: data.command as PublishCommand, ...(data.runId ? { runId: data.runId as string } : {}) }
        }
        const stop = publishControlStop(parsePublishControl(control.data()), command) ?? publishRequesterStop(command.requestedBy, member?.data())
        if (stop) return stop
        if (batch.get('env') !== env || batch.get('state') !== 'approved' || batch.get('revision') !== command.revision || batch.get('approval')?.revision !== command.revision - 1) return 'superseded_revision'
        if (receipt.get('committedAt')) return 'superseded'
        if (batch.get('baselineVersion') !== pointer.get('version') || receipt.exists && receipt.get('fromVersion') !== pointer.get('version')) return 'stale_baseline'
        const pending = batch.get('publishCommand')
        if (pending?.revision === command.revision && !isPublishStop((await transaction.get(db.doc(`publishCommandStops/${pending.commandId}`))).get('reason'))) return 'locked'
        transaction.create(ref, { env, command, acceptedAt: now })
        transaction.update(batch.ref, { publishCommand: { commandId: command.commandId, revision: command.revision } })
        return { command }
      })
    },
    async bindRun(command, runId, now) {
      return db.runTransaction(async transaction => {
        const ref = db.doc(`publishCommands/${publishCommandKey(command)}`)
        const batchRef = db.doc(`reviewBatches/${command.batchId}`)
        const [accepted, batch, receipt] = await transaction.getAll(ref, batchRef, db.doc(`publishRecords/${command.batchId}@${command.revision}`))
        if (accepted.get('env') !== env || accepted.get('runId') && accepted.get('runId') !== runId) return false
        transaction.update(ref, { runId })
        const current = batch.get('publishCommand')
        const eligible = batch.get('state') === 'approved' && batch.get('revision') === command.revision || batch.get('state') === 'published' && batch.get('revision') === command.revision + 1 && receipt.get('env') === env && receipt.get('commandId') === command.commandId && receipt.get('committedAt')
        if (batch.get('env') === env && eligible && current?.commandId === command.commandId && current.revision === command.revision) {
          transaction.update(batchRef, { approvalRun: { runId, revision: command.revision - 1 }, publishRequestedAt: now, publishRequestedBy: command.requestedBy })
        }
        return true
      })
    },
    async adopt(record, command, checksum, token, now) {
      return db.runTransaction(async transaction => {
        const ref = db.doc(`publishRecords/${record.id}`)
        const requesterRef = memberDocRef(db, command.requestedBy?.email)
        const [lock, saved, batch, pointer, previousStop, control, stopped, member] = await transaction.getAll(
          db.doc('locks/publish'), ref, db.doc(`reviewBatches/${command.batchId}`), db.doc('config/catalog'),
          db.doc(`publishCommandStops/${publishCommandKey(record)}`), db.doc('config/publishControl'),
          db.doc(`publishCommandStops/${publishCommandKey(command)}`), ...(requesterRef ? [requesterRef] : []),
        )
        if (!active(lock.data(), token, env, now) || lock.get('batchId') !== command.batchId || lock.get('revision') !== command.revision) return 'lock_lost'
        if (batch.get('env') !== env || batch.get('state') !== 'approved' || batch.get('revision') !== command.revision || batch.get('approval')?.revision !== command.revision - 1 || batch.get('publishReservation')?.token !== token) return 'superseded_revision'
        const previous = saved.data()
        if (!previous || previous.env !== env || previous.commandId !== record.commandId || previous.committedAt || !isPublishStop(previousStop.get('reason'))) return 'superseded'
        if (previous.supersededCommands?.some((old: PublishCommand) => old.commandId === command.commandId)) return 'superseded'
        if (previous.id !== `${command.batchId}@${command.revision}` || previous.batchId !== command.batchId || previous.revision !== command.revision || previous.toVersion !== previous.fromVersion + 1 || previous.blobSha256 !== checksum || previous.blobSha256 !== record.blobSha256 || previous.toVersion !== record.toVersion || previous.fromVersion !== record.fromVersion) return 'version_taken'
        if (previous.fromVersion !== pointer.get('version') || previous.fromVersion !== batch.get('baselineVersion')) return 'stale_baseline'
        const stop = writePublishStop({ transaction, command, control, stopped, now, member })
        if (stop) return stop
        const { env: storedEnv, ...receipt } = previous
        if (storedEnv !== env) return 'superseded'
        const adopted = { ...receipt, ...command, supersededCommands: [...previous.supersededCommands ?? [], {
          batchId: previous.batchId, revision: previous.revision, commandId: publishCommandKey(record),
          ...(previous.generation !== undefined ? { generation: previous.generation } : {}),
          ...(previous.requestedBy ? { requestedBy: previous.requestedBy } : {}),
        }] } as PublishRecord
        transaction.set(ref, { ...adopted, env })
        return adopted
      })
    },
    async get(id) {
      const snapshot = await db.doc(`publishRecords/${id}`).get()
      const { env: storedEnv, ...record } = snapshot.data() ?? {}
      return storedEnv === env ? record as PublishRecord : null
    },
    async save(record, token, now) {
      return db.runTransaction(async transaction => {
        const ref = db.doc(`publishRecords/${record.id}`)
        const [lock, saved] = await transaction.getAll(db.doc('locks/publish'), ref)
        if (!active(lock.data(), token, env, now)) return false
        if (lock.get('batchId') !== record.batchId || lock.get('revision') !== record.revision) return false
        if (record.id !== `${record.batchId}@${record.revision}` || record.toVersion !== record.fromVersion + 1) return false
        const previous = saved.data()
        if (previous) {
          if (previous.env !== env || ['id', 'batchId', 'revision', 'fromVersion', 'toVersion', 'blobSha256', 'generation', 'commandId'].some(key => previous[key] !== record[key as keyof PublishRecord])) return false
          if (!sameRequester(previous.requestedBy, record.requestedBy)) return false
          if (previous.state === 'done' && record.state !== 'done') return false
          if (previous.state === 'failed' && record.state !== 'failed') return false
          if (previous.state === 'uploaded' && record.state === 'started') return false
        }
        if (record.committedAt && record.committedAt !== previous?.committedAt) return false
        if (record.state === 'done' && !previous?.committedAt) return false
        if (record.state === 'failed' && previous?.committedAt) return false
        transaction.set(ref, { ...record, ...(previous?.committedAt ? { committedAt: previous.committedAt } : {}), env })
        return true
      })
    },
  }
}

export function firestorePublishPointer(db: Firestore, env: string): PublishPointer {
  const pointerRef = db.doc('config/catalog')
  return {
    async read() {
      const snapshot = await pointerRef.get()
      const data = snapshot.data()
      if (typeof data?.version !== 'number') throw new Error('config/catalog has no numeric version')
      return data as { version: number; blobSha256?: string; publishedAt?: string }
    },
    async advance(record, lease, now) {
      return db.runTransaction(async transaction => {
        const recordRef = db.doc(`publishRecords/${record.id}`)
        const requesterRef = memberDocRef(db, record.requestedBy?.email)
        const [lock, batch, receipt, pointer, control, stopped, member] = await transaction.getAll(
          db.doc('locks/publish'), db.doc(`reviewBatches/${record.batchId}`), recordRef, pointerRef, db.doc('config/publishControl'), db.doc(`publishCommandStops/${publishCommandKey(record)}`), ...(requesterRef ? [requesterRef] : []),
        )
        if (!active(lock.data(), lease.token, env, now) || lock.get('batchId') !== record.batchId || lock.get('revision') !== record.revision) return 'lock_lost'
        if (batch.get('env') !== env || batch.get('revision') !== record.revision || batch.get('state') !== 'approved' || batch.get('publishReservation')?.token !== lease.token) return 'superseded_revision'
        if (receipt.get('commandId') !== record.commandId) return PUBLISH_STOPS.superseded
        if (receipt.get('committedAt')) return 'advanced'
        const stop = writePublishStop({ transaction, command: record, control, stopped, now, member })
        if (stop) return stop
        if (typeof record.url !== 'string' || record.url.length === 0) return 'superseded_revision'
        if (receipt.get('env') !== env || receipt.get('blobSha256') !== record.blobSha256 || receipt.get('url') !== record.url || receipt.get('fromVersion') !== record.fromVersion || receipt.get('toVersion') !== record.toVersion) return 'superseded_revision'
        if (!sameRequester(receipt.get('requestedBy'), record.requestedBy)) return PUBLISH_STOPS.superseded
        if (receipt.get('generation') !== record.generation || receipt.get('commandId') !== record.commandId) return PUBLISH_STOPS.superseded
        if (receipt.get('state') !== 'uploaded') return 'superseded_revision'
        if (pointer.get('version') !== record.fromVersion) return 'pointer_moved'
        transaction.set(pointerRef, { version: record.toVersion, url: record.url, blobSha256: record.blobSha256, publishedAt: now })
        transaction.update(recordRef, { committedAt: now })
        return 'advanced'
      })
    },
  }
}

export function firestorePublishCurator(db: Firestore, env: string): PublishCurator {
  return {
    async writeStateOrders(orders, lease, now) {
      return db.runTransaction(async transaction => {
        const ref = db.doc('curator/workflow')
        const [lock, workflow] = await transaction.getAll(db.doc('locks/publish'), ref)
        if (!active(lock.data(), lease.token, env, now) || lock.get('batchId') !== lease.batchId || lock.get('revision') !== lease.revision) return 'lock_lost'
        if (Object.keys(orders).length > 0) {
          transaction.set(ref, { stateOrder: { ...workflow.get('stateOrder'), ...orders } }, { mergeFields: ['stateOrder'] })
        }
        return 'ok'
      })
    },
  }
}

export function firestorePublishControl(db: Firestore): PublishControl & {
  change(paused: boolean, actor: { uid: string; email: string }, now: string): Promise<PublishControlState | typeof PUBLISH_STOPS.notEnabled | null>
} {
  const ref = db.doc('config/publishControl')
  return {
    async read() { return parsePublishControl((await ref.get()).data()) },
    async change(paused, actor, now) {
      return db.runTransaction(async transaction => {
        const requesterRef = memberDocRef(db, actor.email)
        if (!requesterRef) return null
        const [snapshot, member] = await transaction.getAll(ref, requesterRef)
        if (!isActiveOwner(member.data()) || member.get('uid') !== actor.uid) return null
        const previous = parsePublishControl(snapshot.data())
        if (!previous && paused) return PUBLISH_STOPS.notEnabled
        if (snapshot.exists && !previous) throw new Error('Malformed publication control')
        const generation = (previous?.generation ?? 0) + 1
        if (!Number.isSafeInteger(generation)) throw new Error('Publication generation exhausted')
        const control = { paused, generation, changedBy: actor, changedAt: now }
        transaction.set(ref, control)
        return control
      })
    },
    async check(command: PublishCommand, now: string) {
      return db.runTransaction(async transaction => {
        const stopRef = db.doc(`publishCommandStops/${publishCommandKey(command)}`)
        const requesterRef = memberDocRef(db, command.requestedBy?.email)
        const [control, stopped, receipt, member] = await transaction.getAll(ref, stopRef, db.doc(`publishRecords/${command.batchId}@${command.revision}`), ...(requesterRef ? [requesterRef] : []))
        if (receipt.get('committedAt')) return null
        return writePublishStop({ transaction, command, control, stopped, now, member })
      })
    },
  }
}
