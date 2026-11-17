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
