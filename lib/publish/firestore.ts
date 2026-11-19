import {
  abandonClaim,
  abandonmentCommands,
  abandonmentError,
  abandonmentPlan,
  abandonedReceiptId,
} from './abandon'
import { nextPublishVersion, occupiesTarget, validTarget } from './allocation'
import { publishRequesterStop, sameRequester } from './authority'
import {
  batchApprovedFor,
  claimSupersedes,
  draftCanBeConfirmed,
  hasDraftChanges,
  isSuperseded,
  receiptId,
} from './command'
import {
  CLAIM_TTL_MS,
  claimRunKey,
  resolveClaimRun,
  retryEligibility,
  terminalRun,
  type EligibilityInput,
  type PublishRunLookup,
} from './eligibility'
import { liveEnvKey, signalPath } from '../review/live-signal'
import {
  deletionPublishFenceRef,
  firestoreReviewStore,
  writePublishMetadata,
} from '../review/firestore-store'
import { uploadError } from './upload'
import { sameObject } from './object'
import type { EditableFields, ReviewBatch } from '../review/types'
import { isActiveOwner, normalizeEmail } from '../members/member'
import { countActivePipeline, hasActivePipeline } from './pipeline-gate'
import {
  isPublishStop,
  PIPELINE_BUSY,
  PUBLISH_STOPS,
  type PublishStop,
} from './stop'
import {
  parsePublishControl,
  publishCommandKey,
  publishControlStop,
} from './control'
import type {
  PublishCommand,
  PublishControl,
  PublishControlState,
} from './types'
import {
  FieldValue,
  type DocumentData,
  type DocumentSnapshot,
  type Transaction,
  type Firestore,
} from '@google-cloud/firestore'
import type {
  PublishCurator,
  PublishLock,
  PublishPointer,
  PublishRecord,
  PublishRecords,
} from './types'

/** Locate the requester's membership document for transactional authority checks. */
function memberDocRef(db: Firestore, email: string | undefined) {
  return email
    ? db.doc(`members/${encodeURIComponent(normalizeEmail(email))}`)
    : null
}

/**
 * Evaluate control and membership and persist the first durable stop reason for this
 * command.
 */
function writePublishStop({
  transaction,
  command,
  control,
  stopped,
  now,
  member,
}: {
  transaction: Transaction
  command: PublishCommand
  control: DocumentSnapshot
  stopped: DocumentSnapshot
  now: string
  member?: DocumentSnapshot
}): PublishStop | null {
  const reason: unknown =
    stopped.get('reason') ??
    publishControlStop(parsePublishControl(control.data()), command) ??
    publishRequesterStop(command.requestedBy, member?.data())
  if (reason === null) return null
  if (!isPublishStop(reason)) throw new Error('Malformed Publish stop')
  if (!stopped.exists)
    transaction.set(stopped.ref, { ...command, reason, stoppedAt: now })
  return reason
}

/** Check a lease timestamp against the operation's clock before trusting it. */
function unexpired(expiresAt: unknown, now: string): boolean {
  return (
    typeof expiresAt === 'string' && Date.parse(expiresAt) > Date.parse(now)
  )
}

/** Require both the lease token and an unexpired deadline to prove lock ownership. */
function active(
  data: DocumentData | undefined,
  token: string,
  env: string,
  now: string
): boolean {
  return (
    data?.token === token && data.env === env && unexpired(data.expiresAt, now)
  )
}

/**
 * Build the Firestore publish lease that coordinates publishers and other catalog
 * activity.
 */
export function firestorePublishLock(db: Firestore, env: string): PublishLock {
  const lockRef = db.doc('locks/publish')
  return {
    /**
     * Acquire an available publish lease and honor pipeline and ownership constraints in
     * the same transaction.
     */
    async claim(lease, now) {
      if (!unexpired(lease.expiresAt, now)) return false
      return db.runTransaction(async (transaction) => {
        const batchRef = db.doc(`reviewBatches/${lease.batchId}`)
        const [lock, batch] = await transaction.getAll(lockRef, batchRef)
        if (lock.exists && unexpired(lock.get('expiresAt'), now)) return false
        const data = batch.data()
        const recordId = receiptId(lease.batchId, lease.revision)
        if (
          lease.purpose !== 'abandon' &&
          (await hasActivePipeline(db, transaction, env))
        ) {
          const receipt = await transaction.get(
            db.doc(`publishRecords/${recordId}`)
          )
          if (receipt.get('env') !== env || !receipt.get('committedAt'))
            return false
        }
        if (data?.env !== env) return false
        if (
          lease.purpose !== 'abandon' &&
          (data.state !== 'approved' ||
            data.revision !== lease.revision ||
            (data.publishReservation &&
              data.publishReservation.recordId !== recordId))
        )
          return false
        transaction.set(lockRef, { ...lease, env })
        if (lease.purpose !== 'abandon')
          transaction.update(batchRef, {
            publishReservation: { recordId, token: lease.token },
          })
        return true
      })
    },
    /** Extend a lease only while its token still owns the active lock. */
    async renew(lease, now) {
      return db.runTransaction(async (transaction) => {
        const lock = await transaction.get(lockRef)
        if (
          !active(lock.data(), lease.token, env, now) ||
          !unexpired(lease.expiresAt, now)
        )
          return false
        if (
          lock.get('batchId') !== lease.batchId ||
          lock.get('revision') !== lease.revision
        )
          return false
        transaction.update(lockRef, { expiresAt: lease.expiresAt })
        return true
      })
    },
    /** Release a matching publish lease or retain its freeze for receipt recovery. */
    async release(token, keepBatchFrozen) {
      await db.runTransaction(async (transaction) => {
        const lock = await transaction.get(lockRef)
        if (lock.get('token') !== token || lock.get('env') !== env) return
        const batchRef = db.doc(`reviewBatches/${lock.get('batchId')}`)
        const batch = await transaction.get(batchRef)
        if (
          !keepBatchFrozen &&
          batch.get('publishReservation')?.token === token
        ) {
          transaction.update(batchRef, {
            publishReservation: FieldValue.delete(),
          })
        }
        transaction.delete(lockRef)
      })
    },
  }
}

/** The fence document counting accepted releases of one shared draft. */
function releaseFencePath(draftId: string) {
  return `releaseFences/${draftId}`
}

/** Build the transactional publish receipt adapter that fences competing workflows. */
export function firestorePublishRecords(
  db: Firestore,
  env: string,
  options: PublishRunLookup & { claimTtlMs?: number } = {}
): PublishRecords {
  /**
   * Gather the current claim, approval run and comparison key for workflow status
   * checks.
   */
  const runContext = (
    batch: DocumentSnapshot,
    receipt: PublishRecord | null,
    claimDoc: DocumentSnapshot | null,
    command: PublishCommand,
    now: string,
    abandoning = false
  ) => {
    const pending =
      batch.get('publishCommand')?.revision === command.revision
        ? batch.get('publishCommand')
        : undefined
    let claim =
      claimDoc?.get('env') === env
        ? (claimDoc.data() as EligibilityInput['claim'])
        : undefined
    if (abandoning)
      claim = abandonClaim(
        batch.get('env') === env ? (batch.data() as ReviewBatch) : null,
        receipt ?? (command as PublishRecord),
        claim,
        now,
        options.claimTtlMs
      )
    else if (pending && !claim)
      claim = {
        command: {
          batchId: command.batchId,
          revision: command.revision,
          commandId: pending.commandId,
        },
        acceptedAt: new Date(
          Date.parse(now) - (options.claimTtlMs ?? CLAIM_TTL_MS)
        ).toISOString(),
      }
    const approvalRun = batch.get('approvalRun')
    const key = claimRunKey(
      pending,
      approvalRun,
      claim,
      abandoning ? receipt : undefined
    )
    return { claim, approvalRun, key }
  }
  /**
   * Resolve runtime workflow evidence outside the write transaction before checking it
   * against fresh data.
   */
  const resolveRun = async (
    command: PublishCommand,
    now: string,
    abandoning = false
  ) => {
    const context = await db.runTransaction(
      async (transaction) => {
        const [batch, receipt] = await transaction.getAll(
          db.doc('reviewBatches/' + command.batchId),
          db.doc(
            'publishRecords/' + receiptId(command.batchId, command.revision)
          )
        )
        const pending = batch.get('publishCommand')
        const claimDoc =
          pending?.revision === command.revision
            ? await transaction.get(
                db.doc('publishCommands/' + pending.commandId)
              )
            : null
        const context = runContext(
          batch,
          receipt.get('env') === env ? (receipt.data() as PublishRecord) : null,
          claimDoc,
          command,
          now,
          abandoning
        )
        const stop = context.claim
          ? await transaction.get(
              db.doc(
                'publishCommandStops/' +
                  publishCommandKey(context.claim.command)
              )
            )
          : null
        return { ...context, stopped: isPublishStop(stop?.get('reason')) }
      },
      { readOnly: true }
    )
    const resolved = context.stopped
      ? { claim: context.claim, status: undefined }
      : await resolveClaimRun(context.claim, options)
    let status = resolved.status
    if (
      !context.claim &&
      context.approvalRun?.revision === command.revision - 1
    ) {
      try {
        status = await (options.runStatus?.(context.approvalRun.runId) ??
          Promise.resolve('running'))
      } catch {
        status = undefined
      }
    }
    return { key: context.key, resolved: { ...resolved, status } }
  }
  type RunEvidence = Awaited<ReturnType<typeof resolveRun>>
  /**
   * Read the receipt, archive and batch together to validate abandonment against current
   * state.
   */
  const inspectAbandon = async (
    transaction: Transaction,
    record: PublishRecord,
    now: string,
    evidence: RunEvidence
  ) => {
    const [saved, archived, batch, pointer] = await transaction.getAll(
      db.doc('publishRecords/' + record.id),
      db.doc('publishRecords/' + abandonedReceiptId(record)),
      db.doc('reviewBatches/' + record.batchId),
      db.doc('config/catalog')
    )
    const previous =
      saved.get('env') === env ? (saved.data() as PublishRecord) : null
    const disposition =
      archived.get('env') === env
        ? (archived.get('abandonment') as PublishRecord['abandonment'])
        : undefined
    const pending = batch.get('publishCommand')
    const claimDoc =
      pending?.revision === record.revision
        ? await transaction.get(db.doc('publishCommands/' + pending.commandId))
        : null
    const context = runContext(batch, previous, claimDoc, record, now, true)
    const claim = context.claim!
    const stop = await transaction.get(
      db.doc('publishCommandStops/' + publishCommandKey(claim.command))
    )
    const targets = await transaction.get(
      db.collection('publishRecords').where('toVersion', '==', record.toVersion)
    )
    const error = disposition
      ? null
      : batch.get('env') !== env
        ? ('superseded' as const)
        : abandonmentError({
            saved: previous,
            expected: record,
            liveVersion: pointer.get('version'),
            committedTarget: targets.docs.some(
              (target) => !!target.get('committedAt')
            ),
            claim,
            stop: isPublishStop(stop.get('reason')) ? stop.get('reason') : null,
            status: evidence.resolved.status,
            now,
            ttl: options.claimTtlMs,
            claimChanged: context.key !== evidence.key,
          })
    return {
      error,
      disposition,
      saved,
      batch,
      claim,
      commands: previous ? abandonmentCommands(previous, claim) : [],
    }
  }
  /**
   * Inspect command authority, control, claim and receipt before allowing a retry or new
   * reservation.
   */
  const inspect = async (
    transaction: Transaction,
    command: PublishCommand,
    now: string,
    evidence: RunEvidence,
    replay = false
  ) => {
    const requesterRef = memberDocRef(db, command.requestedBy?.email)
    const [batch, pointer, receipt, control, ownStop] =
      await transaction.getAll(
        db.doc(`reviewBatches/${command.batchId}`),
        db.doc('config/catalog'),
        db.doc(
          `publishRecords/${receiptId(command.batchId, command.revision)}`
        ),
        db.doc('config/publishControl'),
        db.doc(`publishCommandStops/${publishCommandKey(command)}`)
      )
    const member = requesterRef ? await transaction.get(requesterRef) : null
    const pending = batch.get('publishCommand')
    const claimDoc =
      pending?.revision === command.revision
        ? await transaction.get(db.doc(`publishCommands/${pending.commandId}`))
        : null
    const claimStop =
      pending?.revision === command.revision
        ? await transaction.get(
            db.doc(`publishCommandStops/${pending.commandId}`)
          )
        : null
    const receiptStop = receipt.exists
      ? await transaction.get(
          db.doc(
            `publishCommandStops/${publishCommandKey(receipt.data() as PublishRecord)}`
          )
        )
      : null
    const context = runContext(
      batch,
      receipt.get('env') === env ? (receipt.data() as PublishRecord) : null,
      claimDoc,
      command,
      now
    )
    const changed = context.key !== evidence.key
    const resolved = evidence.resolved
    const claim = changed ? context.claim : resolved.claim
    const status = changed ? undefined : resolved.status
    const currentBatch =
      batch.get('env') === env ? (batch.data() as ReviewBatch) : null
    const confirmed =
      !replay &&
      currentBatch &&
      draftCanBeConfirmed(currentBatch) &&
      !batch.get('publishReservation') &&
      command.confirmedDraftRevision === currentBatch.revision &&
      command.revision === currentBatch.revision + 1 &&
      command.requestedBy
        ? {
            state: 'approved' as const,
            revision: command.revision,
            approval: {
              revision: currentBatch.revision,
              by: command.requestedBy.uid,
              at: now,
            },
          }
        : null
    const input: EligibilityInput = {
      command,
      batch: confirmed ? { ...currentBatch!, ...confirmed } : currentBatch,
      control: parsePublishControl(control.data()),
      member: member?.data(),
      liveVersion: pointer.get('version'),
      receipt:
        receipt.get('env') === env ? (receipt.data() as PublishRecord) : null,
      claim:
        claim ??
        (pending?.revision === command.revision
          ? {
              command: {
                batchId: command.batchId,
                revision: command.revision,
                commandId: pending.commandId,
              },
              acceptedAt: now,
            }
          : undefined),
      claimStop: isPublishStop(claimStop?.get('reason'))
        ? claimStop!.get('reason')
        : null,
      receiptStop: isPublishStop(receiptStop?.get('reason'))
        ? receiptStop!.get('reason')
        : null,
      ownStop: isPublishStop(ownStop.get('reason'))
        ? ownStop.get('reason')
        : null,
      runStatus: status,
      now,
      claimTtlMs: options.claimTtlMs,
      replay,
    }
    const edits = confirmed
      ? await transaction.get(batch.ref.collection('edits').select('fields'))
      : null
    const emptyDraft =
      edits &&
      !hasDraftChanges(
        currentBatch!,
        edits.docs.map((edit) => (edit.get('fields') ?? {}) as EditableFields)
      )
    const eligibility =
      !replay && command.confirmedDraftRevision !== undefined && !confirmed
        ? { canRetry: false, reason: 'superseded_revision' as const }
        : changed
          ? { canRetry: false, reason: 'locked' as const }
          : emptyDraft
            ? { canRetry: false, reason: 'empty_batch' as const }
            : retryEligibility(input)
    const recoverRun = () => {
      if (
        !changed &&
        'recoveredRunId' in resolved &&
        resolved.recoveredRunId &&
        status !== 'not_found' &&
        !terminalRun(status) &&
        claimDoc &&
        claim
      ) {
        if (claimDoc.exists)
          transaction.update(claimDoc.ref, { runId: resolved.recoveredRunId })
        else transaction.create(claimDoc.ref, { ...claim, env })
        if (
          batch.get('env') === env &&
          batchApprovedFor(batch.data(), claim.command)
        ) {
          writePublishMetadata(transaction, batch, {
            approvalRun: {
              runId: resolved.recoveredRunId,
              revision: claim.command.revision - 1,
            },
            publishRequestedAt: claim.acceptedAt,
            ...(claim.command.requestedBy
              ? { publishRequestedBy: claim.command.requestedBy }
              : {}),
          })
        }
      }
    }
    return {
      eligibility,
      batch,
      input,
      claimStop,
      receiptStop,
      changed,
      confirmed,
      recoverRun,
    }
  }
  return {
    /** Check for active pipeline work in a read-only transaction before publishing. */
    async pipelineBusy() {
      return db.runTransaction((tx) => hasActivePipeline(db, tx, env), {
        readOnly: true,
      })
    },
    /** Count active pipeline work so a blocked Publish can say how much remains. */
    async activePipelineRuns() {
      return db.runTransaction((tx) => countActivePipeline(db, tx, env), {
        readOnly: true,
      })
    },
    /**
     * Allocate the next snapshot version from the live pointer and current reservations.
     */
    async nextVersion(token, now) {
      return db.runTransaction(async (transaction) => {
        const [lock, pointer] = await transaction.getAll(
          db.doc('locks/publish'),
          db.doc('config/catalog')
        )
        const receipts = await transaction.get(
          db
            .collection('publishRecords')
            .where('toVersion', '>', pointer.get('version'))
        )
        const burns = await transaction.get(
          db.collection('publishVersionBurns')
        )
        if (!active(lock.data(), token, env, now)) return null
        return nextPublishVersion(
          pointer.get('version'),
          burns.docs.map((burn) => Number(burn.id)),
          receipts.docs.map((receipt) => receipt.data() as PublishRecord)
        )
      })
    },
    /**
     * Check abandonment eligibility with current receipt state and matching workflow
     * evidence.
     */
    async abandonmentEligibility(record, now) {
      const evidence = await resolveRun(record, now, true)
      return db.runTransaction(
        async (transaction) =>
          (await inspectAbandon(transaction, record, now, evidence)).error,
        { readOnly: true }
      )
    },
    /** Archive an eligible prepared receipt and fence its commands in one transaction. */
    async abandon(record, actor, reason, object, token, now) {
      const evidence = await resolveRun(record, now, true)
      return db.runTransaction(async (transaction) => {
        const requesterRef = memberDocRef(db, actor.email)
        if (!requesterRef) return { ok: false, error: 'forbidden' }
        const [lock, member] = await transaction.getAll(
          db.doc('locks/publish'),
          requesterRef
        )
        const inspected = await inspectAbandon(
          transaction,
          record,
          now,
          evidence
        )
        const burnRef = db.doc(`publishVersionBurns/${record.toVersion}`)
        const burn = await transaction.get(burnRef)
        const stops = await Promise.all(
          inspected.commands.map((command) =>
            transaction.get(
              db.doc(`publishCommandStops/${publishCommandKey(command)}`)
            )
          )
        )
        if (publishRequesterStop(actor, member.data()))
          return { ok: false, error: 'forbidden' }
        if (inspected.disposition)
          return { ok: true, value: inspected.disposition }
        if (
          !active(lock.data(), token, env, now) ||
          lock.get('batchId') !== record.batchId ||
          lock.get('revision') !== record.revision
        )
          return { ok: false, error: 'lock_lost' }
        if (inspected.error) return { ok: false, error: inspected.error }
        if (burn.exists) return { ok: false, error: 'version_taken' }
        const plan = abandonmentPlan(
          inspected.saved.data() as PublishRecord,
          inspected.claim,
          actor,
          reason,
          object,
          now
        )
        const disposition = plan.disposition
        transaction.create(
          db.doc('publishRecords/' + plan.archived.id),
          plan.archived
        )
        transaction.delete(inspected.saved.ref)
        transaction.create(burnRef, { ...disposition, env })
        const written = new Set<string>()
        for (const stop of stops)
          if (!stop.exists && !written.has(stop.ref.path)) {
            transaction.create(stop.ref, {
              reason: PUBLISH_STOPS.superseded,
              stoppedAt: now,
            })
            written.add(stop.ref.path)
          }
        writePublishMetadata(transaction, inspected.batch, {
          publishAbandonment: disposition,
        })
        if (inspected.batch.get('publishReservation')?.recordId === record.id)
          transaction.update(inspected.batch.ref, {
            publishReservation: FieldValue.delete(),
          })
        return { ok: true, value: disposition }
      })
    },
    /**
     * Recheck authority and release state before a workflow creates snapshot bytes in
     * storage.
     */
    async checkUpload(record, command, checksum, token, now) {
      return db.runTransaction(async (transaction) => {
        const requesterRef = memberDocRef(db, command.requestedBy?.email)
        const [lock, batch, saved, pointer, control, stopped, member] =
          await transaction.getAll(
            db.doc('locks/publish'),
            db.doc(`reviewBatches/${command.batchId}`),
            db.doc(
              `publishRecords/${receiptId(command.batchId, command.revision)}`
            ),
            db.doc('config/catalog'),
            db.doc('config/publishControl'),
            db.doc(`publishCommandStops/${publishCommandKey(command)}`),
            ...(requesterRef ? [requesterRef] : [])
          )
        const versions = await transaction.get(
          db
            .collection('publishRecords')
            .where('toVersion', '==', record.toVersion)
        )
        const burn = await transaction.get(
          db.doc(`publishVersionBurns/${record.toVersion}`)
        )
        if (burn.exists) return 'version_taken'
        if (
          !active(lock.data(), token, env, now) ||
          lock.get('batchId') !== command.batchId ||
          lock.get('revision') !== command.revision
        )
          return 'lock_lost'
        if (
          batch.get('env') !== env ||
          !batchApprovedFor(batch.data(), command) ||
          batch.get('publishReservation')?.token !== token
        )
          return 'superseded_revision'
        if (claimSupersedes(batch.data(), command))
          return PUBLISH_STOPS.superseded
        const error = uploadError(
          saved.get('env') === env ? (saved.data() as PublishRecord) : null,
          record,
          command,
          checksum,
          pointer.get('version'),
          versions.docs.some(
            (receipt) =>
              occupiesTarget(receipt.data() as PublishRecord) &&
              (receipt.id !== record.id || !!receipt.get('committedAt'))
          )
        )
        return (
          error ??
          writePublishStop({
            transaction,
            command,
            control,
            stopped,
            now,
            member,
          })
        )
      })
    },
    /**
     * Resolve retry eligibility using workflow evidence and a consistent Firestore read.
     */
    async eligibility(command, now) {
      const evidence = await resolveRun(command, now)
      return db.runTransaction(
        async (transaction) =>
          (await inspect(transaction, command, now, evidence)).eligibility,
        { readOnly: true }
      )
    },
    /** Read the persisted command associated with a publish receipt for recovery. */
    async command(commandId) {
      const saved = await db.doc(`publishCommands/${commandId}`).get()
      return saved.get('env') === env
        ? {
            command: saved.get('command') as PublishCommand,
            ...(saved.get('runId')
              ? { runId: saved.get('runId') as string }
              : {}),
          }
        : null
    },
    /**
     * Load the durable stop reason for a command so retries return the same disposition.
     */
    async stopped(command) {
      const reason: unknown = (
        await db.doc(`publishCommandStops/${publishCommandKey(command)}`).get()
      ).get('reason')
      return isPublishStop(reason) ? reason : null
    },
    /**
     * Accept a publish command transactionally, resolving concurrent claims against
     * refreshed evidence.
     */
    async releaseFence(draftId) {
      const seq = (await db.doc(releaseFencePath(draftId)).get()).get('seq')
      return typeof seq === 'number' ? seq : 0
    },
    async accept(command, now, fence) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const evidence = await resolveRun(command, now)
        const result = await db.runTransaction<
          Awaited<ReturnType<PublishRecords['accept']>> | 'claim_changed'
        >(async (transaction) => {
          if (await hasActivePipeline(db, transaction, env))
            return { ok: false, error: PIPELINE_BUSY }
          const ref = db.doc(`publishCommands/${publishCommandKey(command)}`)
          const accepted = await transaction.get(ref)
          if (accepted.exists) {
            const data = accepted.data()!
            if (
              data.env !== env ||
              data.command.batchId !== command.batchId ||
              data.command.revision !== command.revision ||
              !sameRequester(data.command.requestedBy, command.requestedBy)
            )
              return { ok: false, error: PUBLISH_STOPS.superseded }
            command = data.command as PublishCommand
          }
          const fenceRef = fence
            ? db.doc(releaseFencePath(fence.draftId))
            : null
          const fenced =
            fenceRef && !accepted.exists
              ? await transaction.get(fenceRef)
              : null
          const {
            eligibility,
            batch,
            input,
            claimStop,
            receiptStop,
            changed,
            confirmed,
            recoverRun,
          } = await inspect(
            transaction,
            command,
            now,
            evidence,
            accepted.exists
          )
          if (changed && accepted.exists) return 'claim_changed'
          if (!eligibility.canRetry) {
            recoverRun()
            return { ok: false, error: eligibility.reason! }
          }
          const runId = accepted.get('runId') ?? input.claim?.runId
          const sourceId = batch.get('source.batchId') as string | undefined
          if (
            sourceId &&
            (!accepted.exists || !runId) &&
            batch.get('state') !== 'published'
          ) {
            const deletions = await transaction.get(
              batch.ref.collection('edits').where('fields.deleted', '==', true)
            )
            if (!deletions.empty) {
              const source = db.doc(`reviewBatches/${sourceId}`)
              const [draft, ...current] = await transaction.getAll(
                source,
                ...deletions.docs.map(({ id }) =>
                  source.collection('edits').doc(id)
                )
              )
              if (
                draft.get('env') !== env ||
                draft.get('kind') !== 'shared-draft' ||
                draft.get('baselineVersion') !== batch.get('baselineVersion') ||
                current.some((edit) => edit.get('fields.deleted') !== true)
              )
                return { ok: false, error: 'superseded_revision' }
              // The undo reads this generation in its commit transaction. The edit
              // reads above also serialize acceptance after an undo already committed.
              transaction.set(
                deletionPublishFenceRef(db, sourceId),
                {
                  generation: FieldValue.increment(1),
                },
                { merge: true }
              )
              if (accepted.exists) transaction.update(ref, { acceptedAt: now })
            }
          }
          recoverRun()
          if (accepted.exists) {
            return {
              ok: true,
              command,
              ...(runId ? { runId: runId as string } : {}),
            }
          }
          // Only one release of a shared draft is accepted per fence reading: a request
          // that checked for a holding release before another was accepted refuses.
          const sourceDraft = confirmed
            ? batch.get('source.batchId')
            : undefined
          const seq = fenced?.get('seq')
          if (
            typeof sourceDraft === 'string' &&
            (!fence ||
              !fenceRef ||
              fence.draftId !== sourceDraft ||
              (typeof seq === 'number' ? seq : 0) !== fence.seq)
          )
            return { ok: false, error: 'release_in_progress' }
          if (
            input.claim &&
            input.claim.command.commandId !== command.commandId &&
            !claimStop?.exists
          ) {
            transaction.create(
              db.doc(
                `publishCommandStops/${publishCommandKey(input.claim.command)}`
              ),
              {
                ...input.claim.command,
                reason: PUBLISH_STOPS.superseded,
                stoppedAt: now,
              }
            )
          }
          if (
            input.receipt &&
            input.receipt.commandId !== command.commandId &&
            !receiptStop?.exists &&
            input.receipt.commandId !== input.claim?.command.commandId
          ) {
            transaction.create(
              db.doc(`publishCommandStops/${publishCommandKey(input.receipt)}`),
              {
                batchId: input.receipt.batchId,
                revision: input.receipt.revision,
                commandId: publishCommandKey(input.receipt),
                reason: PUBLISH_STOPS.superseded,
                stoppedAt: now,
              }
            )
          }
          if (typeof sourceDraft === 'string')
            transaction.set(fenceRef!, {
              env,
              seq: fence!.seq + 1,
              releaseId: command.batchId,
              revision: command.confirmedDraftRevision,
              commandId: command.commandId,
              at: now,
            })
          if (confirmed) {
            transaction.update(batch.ref, confirmed)
            transaction.set(
              db.doc(signalPath(liveEnvKey(env), command.batchId)),
              { revision: command.revision }
            )
          }
          transaction.create(ref, { env, command, acceptedAt: now })
          writePublishMetadata(transaction, batch, {
            publishCommand: {
              commandId: command.commandId!,
              revision: command.revision,
            },
          })
          return { ok: true, command }
        })
        if (result !== 'claim_changed') return result
      }
      return { ok: false, error: 'locked' }
    },
    /**
     * Attach the started workflow to its command only while the persisted claim still
     * matches.
     */
    async bindRun(command, runId, now) {
      return db.runTransaction(async (transaction) => {
        const ref = db.doc(`publishCommands/${publishCommandKey(command)}`)
        const batchRef = db.doc(`reviewBatches/${command.batchId}`)
        const [accepted, batch, receipt, stopped] = await transaction.getAll(
          ref,
          batchRef,
          db.doc(
            `publishRecords/${receiptId(command.batchId, command.revision)}`
          ),
          db.doc(`publishCommandStops/${publishCommandKey(command)}`)
        )
        if (
          accepted.get('env') !== env ||
          (accepted.get('runId') && accepted.get('runId') !== runId)
        )
          return false
        const current = batch.get('publishCommand')
        const eligible =
          batchApprovedFor(batch.data(), command) ||
          (batch.get('state') === 'published' &&
            batch.get('revision') === command.revision + 1 &&
            receipt.get('env') === env &&
            receipt.get('commandId') === command.commandId &&
            receipt.get('committedAt'))
        if (
          batch.get('env') !== env ||
          !eligible ||
          current?.commandId !== command.commandId ||
          current.revision !== command.revision ||
          stopped.exists
        )
          return false
        if (
          !(await firestoreReviewStore(
            db,
            env,
            transaction
          ).updatePublishMetadata(command.batchId, batch.get('revision'), {
            approvalRun: { runId, revision: command.revision - 1 },
            publishRequestedAt: accepted.get('acceptedAt') ?? now,
            publishRequestedBy: command.requestedBy,
          }))
        )
          return false
        transaction.update(ref, { runId })
        return true
      })
    },
    /**
     * Adopt an existing receipt for the active command when its ownership fences allow
     * takeover.
     */
    async adopt(record, command, checksum, token, now) {
      return db.runTransaction(async (transaction) => {
        const ref = db.doc(`publishRecords/${record.id}`)
        const requesterRef = memberDocRef(db, command.requestedBy?.email)
        const [
          lock,
          saved,
          batch,
          pointer,
          previousStop,
          control,
          stopped,
          member,
        ] = await transaction.getAll(
          db.doc('locks/publish'),
          ref,
          db.doc(`reviewBatches/${command.batchId}`),
          db.doc('config/catalog'),
          db.doc(`publishCommandStops/${publishCommandKey(record)}`),
          db.doc('config/publishControl'),
          db.doc(`publishCommandStops/${publishCommandKey(command)}`),
          ...(requesterRef ? [requesterRef] : [])
        )
        const burn = await transaction.get(
          db.doc(`publishVersionBurns/${record.toVersion}`)
        )
        const targets = await transaction.get(
          db
            .collection('publishRecords')
            .where('toVersion', '==', record.toVersion)
        )
        if (
          targets.docs.some(
            (receipt) =>
              receipt.id !== record.id &&
              occupiesTarget(receipt.data() as PublishRecord)
          )
        )
          return 'version_taken'
        if (
          !active(lock.data(), token, env, now) ||
          lock.get('batchId') !== command.batchId ||
          lock.get('revision') !== command.revision
        )
          return 'lock_lost'
        if (
          batch.get('env') !== env ||
          !batchApprovedFor(batch.data(), command) ||
          batch.get('publishReservation')?.token !== token
        )
          return 'superseded_revision'
        const previous = saved.data()
        if (claimSupersedes(batch.data(), command))
          return PUBLISH_STOPS.superseded
        if (
          !previous ||
          previous.env !== env ||
          previous.commandId !== record.commandId ||
          previous.committedAt ||
          !isPublishStop(previousStop.get('reason'))
        )
          return PUBLISH_STOPS.superseded
        if (isSuperseded(previous as PublishRecord, command))
          return PUBLISH_STOPS.superseded
        if (
          previous.id !== receiptId(command.batchId, command.revision) ||
          previous.batchId !== command.batchId ||
          previous.revision !== command.revision ||
          !validTarget(previous.fromVersion, previous.toVersion) ||
          previous.state === 'abandoned' ||
          burn.exists ||
          previous.blobSha256 !== checksum ||
          previous.blobSha256 !== record.blobSha256 ||
          previous.toVersion !== record.toVersion ||
          previous.fromVersion !== record.fromVersion
        )
          return 'version_taken'
        if (
          previous.fromVersion !== pointer.get('version') ||
          previous.fromVersion !== batch.get('baselineVersion')
        )
          return 'stale_baseline'
        const stop = writePublishStop({
          transaction,
          command,
          control,
          stopped,
          now,
          member,
        })
        if (stop) return stop
        const { env: storedEnv, ...receipt } = previous
        if (storedEnv !== env) return PUBLISH_STOPS.superseded
        const adopted = {
          ...receipt,
          ...command,
          state: 'started',
          supersededCommands: [
            ...(previous.supersededCommands ?? []),
            {
              batchId: previous.batchId,
              revision: previous.revision,
              commandId: publishCommandKey(record),
              ...(previous.generation !== undefined
                ? { generation: previous.generation }
                : {}),
              ...(previous.requestedBy
                ? { requestedBy: previous.requestedBy }
                : {}),
            },
          ],
        } as PublishRecord
        transaction.set(ref, { ...adopted, env })
        return adopted
      })
    },
    /** Read a publish receipt from this environment by its durable ID. */
    async get(id) {
      const snapshot = await db.doc(`publishRecords/${id}`).get()
      const { env: storedEnv, ...record } = snapshot.data() ?? {}
      return storedEnv === env ? (record as PublishRecord) : null
    },
    /**
     * Save receipt progress only while the caller still owns the release and matches its
     * command.
     */
    async save(record, token, now) {
      return db.runTransaction(async (transaction) => {
        const ref = db.doc(`publishRecords/${record.id}`)
        const [lock, saved, burn] = await transaction.getAll(
          db.doc('locks/publish'),
          ref,
          db.doc(`publishVersionBurns/${record.toVersion}`)
        )
        const versions = await transaction.get(
          db
            .collection('publishRecords')
            .where('toVersion', '==', record.toVersion)
        )
        if (
          burn.exists ||
          saved.get('state') === 'abandoned' ||
          record.state === 'abandoned'
        )
          return false
        if (
          !saved.exists &&
          versions.docs.some((receipt) =>
            occupiesTarget(receipt.data() as PublishRecord)
          )
        )
          return false
        if (!active(lock.data(), token, env, now)) return false
        if (
          lock.get('batchId') !== record.batchId ||
          lock.get('revision') !== record.revision
        )
          return false
        if (
          record.id !== receiptId(record.batchId, record.revision) ||
          !validTarget(record.fromVersion, record.toVersion)
        )
          return false
        const previous = saved.data()
        if (previous) {
          if (
            previous.env !== env ||
            [
              'id',
              'batchId',
              'revision',
              'fromVersion',
              'toVersion',
              'blobSha256',
              'generation',
              'commandId',
            ].some(
              (key) => previous[key] !== record[key as keyof PublishRecord]
            )
          )
            return false
          if (!sameRequester(previous.requestedBy, record.requestedBy))
            return false
          if (previous.state === 'done' && record.state !== 'done') return false
          if (previous.state === 'failed' && record.state !== 'failed')
            return false
          if (previous.state === 'uploaded' && record.state === 'started')
            return false
        }
        if (record.committedAt && record.committedAt !== previous?.committedAt)
          return false
        if (record.state === 'done' && !previous?.committedAt) return false
        if (record.state === 'failed' && previous?.committedAt) return false
        transaction.set(ref, {
          ...record,
          ...(previous?.committedAt
            ? { committedAt: previous.committedAt }
            : {}),
          env,
        })
        return true
      })
    },
  }
}

/** Build the Firestore live catalog pointer adapter used to commit releases. */
export function firestorePublishPointer(
  db: Firestore,
  env: string,
  verifyObject: (record: PublishRecord) => Promise<boolean>
): PublishPointer {
  const pointerRef = db.doc('config/catalog')
  return {
    /** Read the live catalog pointer and the metadata recorded at publish time. */
    async read() {
      const snapshot = await pointerRef.get()
      const data = snapshot.data()
      if (typeof data?.version !== 'number')
        throw new Error('config/catalog has no numeric version')
      return data as {
        version: number
        blobSha256?: string
        publishedAt?: string
      }
    },
    /**
     * Advance the live pointer only after verifying the prepared object and rechecking
     * transactional publish fences.
     */
    async advance(record, lease, now) {
      const observed = await db.doc('publishRecords/' + record.id).get()
      const verified = observed.get('committedAt')
        ? true
        : await verifyObject(record)
      return db.runTransaction(async (transaction) => {
        const recordRef = db.doc(`publishRecords/${record.id}`)
        const requesterRef = memberDocRef(db, record.requestedBy?.email)
        const [lock, batch, receipt, pointer, control, stopped, member] =
          await transaction.getAll(
            db.doc('locks/publish'),
            db.doc(`reviewBatches/${record.batchId}`),
            recordRef,
            pointerRef,
            db.doc('config/publishControl'),
            db.doc(`publishCommandStops/${publishCommandKey(record)}`),
            ...(requesterRef ? [requesterRef] : [])
          )
        const burn = await transaction.get(
          db.doc(`publishVersionBurns/${record.toVersion}`)
        )
        if (burn.exists || receipt.get('state') === 'abandoned')
          return 'version_taken'
        if (
          !active(lock.data(), lease.token, env, now) ||
          lock.get('batchId') !== record.batchId ||
          lock.get('revision') !== record.revision
        )
          return 'lock_lost'
        if (
          batch.get('env') !== env ||
          batch.get('revision') !== record.revision ||
          batch.get('state') !== 'approved' ||
          batch.get('publishReservation')?.token !== lease.token
        )
          return 'superseded_revision'
        if (claimSupersedes(batch.data(), record))
          return PUBLISH_STOPS.superseded
        if (receipt.get('commandId') !== record.commandId)
          return PUBLISH_STOPS.superseded
        if (receipt.get('committedAt')) return 'advanced'
        if (await hasActivePipeline(db, transaction, env)) return PIPELINE_BUSY
        const targets = await transaction.get(
          db
            .collection('publishRecords')
            .where('toVersion', '==', record.toVersion)
        )
        if (
          targets.docs.some(
            (target) =>
              target.id !== record.id &&
              occupiesTarget(target.data() as PublishRecord)
          )
        )
          return 'version_taken'
        const stop = writePublishStop({
          transaction,
          command: record,
          control,
          stopped,
          now,
          member,
        })
        if (stop) return stop
        if (typeof record.url !== 'string' || record.url.length === 0)
          return 'superseded_revision'
        if (
          receipt.get('env') !== env ||
          receipt.get('blobSha256') !== record.blobSha256 ||
          receipt.get('url') !== record.url ||
          receipt.get('fromVersion') !== record.fromVersion ||
          receipt.get('toVersion') !== record.toVersion
        )
          return 'superseded_revision'
        if (!sameRequester(receipt.get('requestedBy'), record.requestedBy))
          return PUBLISH_STOPS.superseded
        if (
          receipt.get('generation') !== record.generation ||
          receipt.get('commandId') !== record.commandId
        )
          return PUBLISH_STOPS.superseded
        if (receipt.get('state') !== 'uploaded') return 'superseded_revision'
        if (pointer.get('version') !== record.fromVersion)
          return 'pointer_moved'
        if (!sameObject(receipt.get('object'), record.object))
          return 'version_taken'
        if (!verified) return 'version_taken'
        transaction.set(pointerRef, {
          version: record.toVersion,
          url: record.url,
          blobSha256: record.blobSha256,
          publishedAt: now,
        })
        transaction.update(recordRef, { committedAt: now })
        return 'advanced'
      })
    },
  }
}

/**
 * Build the adapter that projects committed catalog state order back into curator data.
 */
export function firestorePublishCurator(
  db: Firestore,
  env: string
): PublishCurator {
  return {
    /**
     * Write state ordering for the committed version while rejecting stale or already
     * superseded work.
     */
    async writeStateOrders(orders, lease, now, record, live) {
      return db.runTransaction(async (transaction) => {
        const ref = db.doc('curator/workflow')
        const [lock, workflow, pointer, receipt] = await transaction.getAll(
          db.doc('locks/publish'),
          ref,
          db.doc('config/catalog'),
          db.doc('publishRecords/' + record.id)
        )
        if (
          !active(lock.data(), lease.token, env, now) ||
          lock.get('batchId') !== lease.batchId ||
          lock.get('revision') !== lease.revision
        )
          return 'lock_lost'
        if (
          record.id !== receiptId(lease.batchId, lease.revision) ||
          receipt.get('env') !== env ||
          !receipt.get('committedAt') ||
          receipt.get('batchId') !== lease.batchId ||
          receipt.get('revision') !== lease.revision ||
          receipt.get('fromVersion') !== record.fromVersion ||
          receipt.get('toVersion') !== record.toVersion ||
          receipt.get('blobSha256') !== record.blobSha256 ||
          receipt.get('commandId') !== record.commandId
        )
          return 'unavailable'
        if (!Number.isSafeInteger(pointer.get('version'))) return 'unavailable'
        const stateOrder = { ...workflow.get('stateOrder') }
        const stateOrderVersion = { ...workflow.get('stateOrderVersion') }
        const legacy = Object.keys(orders).filter(
          (state) =>
            typeof stateOrderVersion[state] !== 'number' &&
            Object.hasOwn(stateOrder, state) &&
            pointer.get('version') > record.toVersion
        )
        if (
          legacy.length &&
          (!live ||
            live.version !== pointer.get('version') ||
            live.blobSha256 !== pointer.get('blobSha256'))
        )
          return 'reconcile'
        const writes = Object.entries(orders).filter(
          ([state]) =>
            typeof stateOrderVersion[state] !== 'number' ||
            stateOrderVersion[state] <= record.toVersion
        )
        for (const [state, order] of writes) {
          stateOrder[state] = legacy.includes(state)
            ? live!.orders[state]
            : order
          stateOrderVersion[state] = legacy.includes(state)
            ? live!.version
            : record.toVersion
        }
        if (writes.length > 0) {
          transaction.set(
            ref,
            { stateOrder, stateOrderVersion },
            { mergeFields: ['stateOrder', 'stateOrderVersion'] }
          )
        }
        return 'ok'
      })
    },
  }
}

/** Build the Firestore adapter for global publish controls and durable command stops. */
export function firestorePublishControl(db: Firestore): PublishControl & {
  change(
    paused: boolean,
    actor: { uid: string; email: string },
    now: string
  ): Promise<PublishControlState | typeof PUBLISH_STOPS.notEnabled | null>
} {
  const ref = db.doc('config/publishControl')
  return {
    /** Read and validate the current publish control record. */
    async read() {
      return parsePublishControl((await ref.get()).data())
    },
    /**
     * Change publish controls transactionally so in-flight commands can detect a new
     * generation.
     */
    async change(paused, actor, now) {
      return db.runTransaction(async (transaction) => {
        const requesterRef = memberDocRef(db, actor.email)
        if (!requesterRef) return null
        const [snapshot, member] = await transaction.getAll(ref, requesterRef)
        if (!isActiveOwner(member.data()) || member.get('uid') !== actor.uid)
          return null
        const previous = parsePublishControl(snapshot.data())
        if (!previous && paused) return PUBLISH_STOPS.notEnabled
        if (snapshot.exists && !previous)
          throw new Error('Malformed publication control')
        const generation = (previous?.generation ?? 0) + 1
        if (!Number.isSafeInteger(generation))
          throw new Error('Publication generation exhausted')
        const control = { paused, generation, changedBy: actor, changedAt: now }
        transaction.set(ref, control)
        return control
      })
    },
    /** Check publish control and requester authority and persist any command stop. */
    async check(command: PublishCommand, now: string) {
      return db.runTransaction(async (transaction) => {
        const stopRef = db.doc(
          `publishCommandStops/${publishCommandKey(command)}`
        )
        const requesterRef = memberDocRef(db, command.requestedBy?.email)
        const [control, stopped, receipt, batch, member] =
          await transaction.getAll(
            ref,
            stopRef,
            db.doc(
              `publishRecords/${receiptId(command.batchId, command.revision)}`
            ),
            db.doc(`reviewBatches/${command.batchId}`),
            ...(requesterRef ? [requesterRef] : [])
          )
        if (receipt.get('committedAt')) return null
        if (claimSupersedes(batch.data(), command))
          return PUBLISH_STOPS.superseded
        return writePublishStop({
          transaction,
          command,
          control,
          stopped,
          now,
          member,
        })
      })
    },
  }
}
