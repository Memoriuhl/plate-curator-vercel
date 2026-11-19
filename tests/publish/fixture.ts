import {
  abandonClaim,
  abandonmentError,
  abandonmentPlan,
  abandonedReceiptId,
} from '../../lib/publish/abandon'
import {
  nextPublishVersion,
  occupiesTarget,
  validTarget,
} from '../../lib/publish/allocation'
import {
  publishRequesterStop,
  sameRequester,
} from '../../lib/publish/authority'
import { uploadError } from '../../lib/publish/snapshots/upload'
import {
  sameObject,
  verifyPreparedObject,
} from '../../lib/publish/snapshots/object'
import {
  batchApprovedFor,
  claimSupersedes,
  isSuperseded,
  receiptId,
} from '../../lib/publish/command'
import {
  claimRunKey,
  CLAIM_TTL_MS,
  resolveClaimRun,
  retryEligibility,
  terminalRun,
  type EligibilityInput,
  type PublishRunLookup,
} from '../../lib/publish/eligibility'
import type { PublishCommand } from '../../lib/publish/types'
import { createHash } from 'node:crypto'
import type { Snapshot } from '../../lib/catalog/types'
import { createMemoryStore } from '../../lib/review/memory-store'
import type { ReviewBatch } from '../../lib/review/types'
import type {
  CatalogPointer,
  PublishDeps,
  PublishLease,
  PublishRecord,
  PublishControlState,
  PublishStop,
} from '../../lib/publish/types'
import {
  publishCommandKey,
  publishControlStop,
} from '../../lib/publish/control'

export const owner = { uid: 'owner', name: null, role: 'owner' } as const
export const batch: ReviewBatch = {
  stateOrders: {},
  id: 'batch',
  name: 'Release',
  createdBy: 'editor',
  createdByName: null,
  createdAt: '2026-11-15T12:00:00Z',
  state: 'approved',
  revision: 2,
  baselineVersion: 1,
  plateIds: ['one'],
  approval: { revision: 1, by: owner.uid, at: '2026-11-15T12:00:00Z' },
}
export const command = {
  batchId: batch.id,
  revision: batch.revision,
  generation: 1,
  commandId: 'command',
  requestedBy: { uid: 'owner', email: 'owner@example.com', authorityEpoch: 0 },
}
export const snapshot: Snapshot = {
  version: 1,
  plates: [
    {
      id: 'one',
      state: 'CA',
      slug: 'one',
      displayName: 'One',
      image: 'one.png',
      tags: ['original'],
    },
    {
      id: 'two',
      state: 'CA',
      slug: 'two',
      displayName: 'Two',
      image: 'two.png',
      tags: [],
    },
  ],
}

/**
 * Build a deterministic release fixture with in-memory leases, commands, snapshots and
 * owner controls.
 */
export function fixture(
  seed: ReviewBatch = batch,
  lookup: PublishRunLookup = {
    /** Control discovery by command token when the fixture has no recorded workflow ID. */ findRun:
      async () => null,
    /** Provide controlled workflow status for the publish or queue recovery scenario. */ runStatus:
      async () => 'running',
  }
) {
  const store = createMemoryStore([seed])
  const blobs = new Map<number, Uint8Array>([
    [1, Buffer.from(JSON.stringify(snapshot))],
  ])
  const objects = new Map<
    number,
    { bytes: Uint8Array; generation: string; token: string }
  >()
  let generation = 0
  /**
   * Read or regenerate the metadata for a stored object after its fixture bytes change.
   */
  const objectAt = (version: number) => {
    const bytes = blobs.get(version)
    if (!bytes) return null
    let object = objects.get(version)
    if (object?.bytes !== bytes) {
      object = {
        bytes,
        generation: String(++generation),
        token: object ? `t${version}g${generation}` : `t${version}`,
      }
      objects.set(version, object)
    }
    return object
  }
  const burns = new Map<number, import('../../lib/publish/types').Abandonment>()
  const records = new Map<string, PublishRecord>()
  const commands = new Map<
    string,
    { command: PublishCommand; acceptedAt: string; runId?: string }
  >()
  let commandQueue = Promise.resolve()
  /**
   * Serialize fixture command updates so competing callers observe the same commit order
   * as Firestore.
   */
  const atomic = <T>(run: () => Promise<T>) => {
    const next = commandQueue.then(run)
    commandQueue = next.then(
      () => {},
      () => {}
    )
    return next
  }
  const stateOrder: Record<string, string[]> = { NY: ['existing'] }
  const stateOrderVersion: Record<string, number> = {}
  let control: PublishControlState | null = {
    paused: false,
    generation: 1,
    changedBy: { uid: 'owner', email: 'owner@example.com' },
    changedAt: '2026-11-16T12:00:00Z',
  }
  let requester: unknown = {
    uid: 'owner',
    role: 'owner',
    status: 'active',
    authorityEpoch: 0,
  }
  const stops = new Map<string, PublishStop>()
  /**
   * Check current publish fences and persist the fixture command's durable stop reason.
   */
  const check = async (cmd: PublishCommand) => {
    if (records.get(`${cmd.batchId}@${cmd.revision}`)?.committedAt) return null
    if (claimSupersedes(await store.getBatch(cmd.batchId), cmd))
      return 'superseded' as const
    const key = publishCommandKey(cmd)
    const stopped = stops.get(key)
    if (stopped) return stopped
    const reason =
      publishControlStop(control, cmd) ??
      publishRequesterStop(cmd.requestedBy, requester)
    if (reason) stops.set(key, reason)
    return reason
  }
  let pointer: CatalogPointer = { version: 1 }
  let lease: PublishLease | null = null
  let reservation: string | null = null
  let reservationBatch: string | null = null
  let time = '2026-11-15T12:00:00Z'
  /** Require the fixture lease token and a deadline after the supplied time. */
  const active = (token: string, now: string) =>
    lease?.token === token && Date.parse(lease.expiresAt) > Date.parse(now)
  const commit = store.commit.bind(store)
  /**
   * Combine the fixture batch, receipt, claim and workflow status to evaluate retry
   * eligibility.
   */
  const inspect = async (
    cmd: PublishCommand,
    now: string,
    replay = false,
    writeRecovered = false
  ) => {
    const current = await store.getBatch(cmd.batchId)
    const receipt = records.get(receiptId(cmd.batchId, cmd.revision)) ?? null
    const pending =
      current?.publishCommand?.revision === cmd.revision
        ? current.publishCommand
        : undefined
    let claim = pending
      ? (commands.get(pending.commandId) ?? {
          command: {
            batchId: cmd.batchId,
            revision: cmd.revision,
            commandId: pending.commandId,
          },
          acceptedAt: new Date(Date.parse(now) - CLAIM_TTL_MS).toISOString(),
        })
      : undefined
    const claimStop = claim
      ? stops.get(publishCommandKey(claim.command))
      : undefined
    const resolved = claimStop
      ? { claim, status: undefined }
      : await resolveClaimRun(claim, lookup)
    claim = resolved.claim
    const approvalRun = current?.approvalRun
    const status = claim
      ? resolved.status
      : approvalRun?.revision === cmd.revision - 1
        ? await (lookup.runStatus?.(approvalRun.runId) ??
            Promise.resolve('running'))
        : undefined
    const input: EligibilityInput = {
      command: cmd,
      batch: current,
      control,
      member: requester,
      liveVersion: (await deps.pointer.read()).version,
      receipt,
      claim,
      claimStop,
      ownStop: stops.get(publishCommandKey(cmd)),
      receiptStop: receipt ? stops.get(publishCommandKey(receipt)) : undefined,
      runStatus: status,
      now,
      replay,
    }
    const eligibility = retryEligibility(input)
    if (
      writeRecovered &&
      'recoveredRunId' in resolved &&
      resolved.recoveredRunId &&
      status !== 'not_found' &&
      !terminalRun(status) &&
      claim
    ) {
      commands.set(publishCommandKey(claim.command), structuredClone(claim))
      if (current && batchApprovedFor(current, claim.command))
        await store.updatePublishMetadata(current.id, current.revision, {
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
    return { input, eligibility, current, receipt, claim }
  }
  /**
   * Read fixture release state and workflow evidence needed to decide whether
   * abandonment is allowed.
   */
  const inspectAbandon = async (record: PublishRecord, now: string) => {
    const saved = records.get(record.id) ?? null
    const current = await store.getBatch(record.batchId)
    const pending =
      current?.publishCommand?.revision === record.revision
        ? current.publishCommand
        : undefined
    const claim = abandonClaim(
      current,
      saved ?? record,
      pending ? commands.get(pending.commandId) : undefined,
      now
    )
    const stop = stops.get(publishCommandKey(claim.command))
    const key = claimRunKey(pending, current?.approvalRun, claim, saved)
    const resolved = stop
      ? { status: undefined }
      : await resolveClaimRun(claim, lookup)
    const latest = await store.getBatch(record.batchId)
    const latestPending =
      latest?.publishCommand?.revision === record.revision
        ? latest.publishCommand
        : undefined
    const latestSaved = records.get(record.id) ?? null
    const latestClaim = abandonClaim(
      latest,
      latestSaved ?? record,
      latestPending ? commands.get(latestPending.commandId) : undefined,
      now
    )
    const claimChanged =
      key !==
      claimRunKey(latestPending, latest?.approvalRun, latestClaim, latestSaved)
    const error = records.get(abandonedReceiptId(record))?.abandonment
      ? null
      : abandonmentError({
          saved,
          expected: record,
          liveVersion: pointer.version,
          committedTarget: [...records.values()].some(
            (other) =>
              other.toVersion === record.toVersion && !!other.committedAt
          ),
          claim,
          stop,
          status: resolved.status,
          now,
          claimChanged,
        })
    return { error, saved, current, claim }
  }
  store.commit = async (id, revision, next) => {
    if (
      reservation &&
      reservationBatch === id &&
      (next.publishToken !== reservation || next.batch.state !== 'published')
    )
      return 'revision_mismatch'
    const result = await commit(id, revision, next)
    if (result === 'ok' && next.batch.state === 'published') reservation = null
    return result
  }
  const deps: PublishDeps = {
    control: {
      /** Expose the current release controls so the publish attempt can check its generation. */ read: async () =>
        control,
      check,
    },
    /** Return fixture baseline plates belonging to the requested state. */
    stateBaseline: async (_version, state) =>
      snapshot.plates.filter((plate) => plate.state === state),
    store,
    /** Resolve the plate by ID from the fixture baseline. */ baselineAtVersion:
      async (_version, id) =>
        snapshot.plates.find((plate) => plate.id === id) ?? null,
    /** Resolve the plate by ID from the fixture baseline. */ baseline: async (
      id
    ) => snapshot.plates.find((plate) => plate.id === id) ?? null,
    /**
     * Read the controlled test clock so state and lease timestamps advance
     * deterministically.
     */
    now: () => time,
    leaseMs: 60000,
    curator: {
      /**
       * Apply committed state orders only while the fixture lease and receipt permit the
       * projection.
       */
      writeStateOrders: async (orders, claim, now, record, live) => {
        if (
          !active(claim.token, now) ||
          lease?.batchId !== claim.batchId ||
          lease.revision !== claim.revision
        )
          return 'lock_lost'
        const saved = records.get(record.id)
        if (
          record.id !== receiptId(claim.batchId, claim.revision) ||
          !saved?.committedAt ||
          saved.batchId !== claim.batchId ||
          saved.revision !== claim.revision ||
          saved.fromVersion !== record.fromVersion ||
          saved.toVersion !== record.toVersion ||
          saved.blobSha256 !== record.blobSha256 ||
          saved.commandId !== record.commandId
        )
          return 'unavailable'
        if (!Number.isSafeInteger(pointer.version)) return 'unavailable'
        const legacy = Object.keys(orders).filter(
          (state) =>
            typeof stateOrderVersion[state] !== 'number' &&
            Object.hasOwn(stateOrder, state) &&
            pointer.version > record.toVersion
        )
        if (
          legacy.length &&
          (!live ||
            live.version !== pointer.version ||
            live.blobSha256 !== pointer.blobSha256)
        )
          return 'reconcile'
        for (const [state, order] of Object.entries(orders)) {
          const version = stateOrderVersion[state]
          if (typeof version === 'number' && version > record.toVersion)
            continue
          stateOrder[state] = structuredClone(
            legacy.includes(state) ? live!.orders[state] : order
          )
          stateOrderVersion[state] = legacy.includes(state)
            ? live!.version
            : record.toVersion
        }
        return 'ok'
      },
    },
    pointer: {
      /** Return a detached live catalog pointer for verification and resume checks. */
      read: async () => structuredClone(pointer),
      /**
       * Simulate the transactional pointer advance and committed receipt checks enforced
       * by Firestore.
       */
      advance: async (record, claim, now) => {
        if (!active(claim.token, now)) return 'lock_lost'
        const current = await store.getBatch(record.batchId)
        if (
          current?.revision !== record.revision ||
          current.state !== 'approved'
        )
          return 'superseded_revision'
        const saved = records.get(record.id)
        if (burns.has(record.toVersion) || saved?.state === 'abandoned')
          return 'version_taken'
        if (saved?.commandId !== record.commandId) return 'superseded'
        if (saved?.committedAt) return 'advanced'
        if (
          [...records.values()].some(
            (other) =>
              other.id !== record.id &&
              other.toVersion === record.toVersion &&
              occupiesTarget(other)
          )
        )
          return 'version_taken'
        const stop = await check(record)
        if (stop) return stop
        if (
          saved?.generation !== record.generation ||
          saved?.commandId !== record.commandId
        )
          return 'superseded'
        if (pointer.version !== record.fromVersion) return 'pointer_moved'
        if (!record.url) return 'superseded_revision'
        if (!sameObject(saved?.object, record.object)) return 'version_taken'
        if (!(await verifyPreparedObject(deps.snapshots, record)))
          return 'version_taken'
        pointer = {
          version: record.toVersion,
          url: record.url,
          blobSha256: record.blobSha256,
          publishedAt: now,
        }
        records.set(record.id, { ...record, committedAt: now })
        return 'advanced'
      },
    },
    snapshots: {
      /**
       * Return snapshot identity and checksum metadata generated from the fixture's
       * current object.
       */
      metadata: async (version) => {
        const object = objectAt(version)
        if (!object) return null
        const url = await deps.snapshots.downloadUrl(version)
        return url
          ? {
              generation: object.generation,
              metageneration: '1',
              md5Hash: createHash('md5').update(object.bytes).digest('base64'),
              url,
            }
          : null
      },
      /** Decode the saved snapshot bytes for the requested fixture version. */
      read: async (version) =>
        JSON.parse(Buffer.from(blobs.get(version)!).toString()) as Snapshot,
      /** Store the prepared bytes only when the fixture version has no object yet. */
      createOnly: async (version, bytes) => {
        if (blobs.has(version)) return 'exists'
        blobs.set(version, Uint8Array.from(bytes))
        return 'created'
      },
      /**
       * Hash the current fixture object independently for prepared receipt verification.
       */
      checksum: async (version, expectedGeneration) => {
        const object = objectAt(version)
        return object &&
          (!expectedGeneration || object.generation === expectedGeneration)
          ? createHash('sha256').update(object.bytes).digest('hex')
          : null
      },
      /** Return the URL for the fixture object's current download token. */
      downloadUrl: async (version) => {
        const object = objectAt(version)
        return object
          ? `https://storage.example/v${version}.json?token=${object.token}`
          : null
      },
    },
    records: {
      /** Allocate a target version only for the owner of the active fixture lease. */
      nextVersion: async (token, now) =>
        active(token, now)
          ? nextPublishVersion(pointer.version, burns.keys(), records.values())
          : null,
      /** Expose the current reason the fixture receipt can or cannot be abandoned. */
      abandonmentEligibility: async (record, now) =>
        (await inspectAbandon(record, now)).error,
      /**
       * Archive a valid fixture receipt and fence its commands under the serialized
       * release update.
       */
      abandon: (record, actor, reason, object, token, now) =>
        atomic(async () => {
          if (publishRequesterStop(actor, requester))
            return { ok: false, error: 'forbidden' }
          const archived = records.get(abandonedReceiptId(record))
          if (archived?.abandonment)
            return { ok: true, value: archived.abandonment }
          if (
            !active(token, now) ||
            lease?.batchId !== record.batchId ||
            lease.revision !== record.revision
          )
            return { ok: false, error: 'lock_lost' }
          const inspected = await inspectAbandon(record, now)
          if (inspected.error) return { ok: false, error: inspected.error }
          const plan = abandonmentPlan(
            inspected.saved!,
            inspected.claim,
            actor,
            reason,
            object,
            now
          )
          records.set(plan.archived.id, structuredClone(plan.archived))
          records.delete(record.id)
          burns.set(record.toVersion, plan.disposition)
          for (const cmd of plan.commands)
            if (!stops.has(publishCommandKey(cmd)))
              stops.set(publishCommandKey(cmd), 'superseded')
          reservation = null
          await store.updatePublishMetadata(
            record.batchId,
            inspected.current!.revision,
            { publishAbandonment: plan.disposition }
          )
          return { ok: true, value: plan.disposition }
        }),
      /**
       * Check the fixture lease, command, receipt and baseline before allowing an
       * upload.
       */
      checkUpload: async (record, cmd, checksum, token, now) => {
        if (!active(token, now)) return 'lock_lost'
        const current = await store.getBatch(cmd.batchId)
        if (
          current?.state !== 'approved' ||
          current.revision !== cmd.revision ||
          current.approval?.revision !== cmd.revision - 1
        )
          return 'superseded_revision'
        if (claimSupersedes(current, cmd)) return 'superseded'
        if (burns.has(record.toVersion)) return 'version_taken'
        return (
          uploadError(
            records.get(record.id) ?? null,
            record,
            cmd,
            checksum,
            pointer.version,
            [...records.values()].some(
              (saved) =>
                saved.toVersion === record.toVersion &&
                occupiesTarget(saved) &&
                (saved.id !== record.id || !!saved.committedAt)
            )
          ) ?? (await check(cmd))
        )
      },
      /**
       * Read retry eligibility within the same serialized queue used by fixture command
       * writes.
       */
      eligibility: (cmd, now) =>
        atomic(async () => (await inspect(cmd, now)).eligibility),
      /** Read the saved command and attached run ID for the requested fixture receipt. */
      command: async (id) => {
        const saved = commands.get(id)
        return saved
          ? structuredClone({
              command: saved.command,
              ...(saved.runId ? { runId: saved.runId } : {}),
            })
          : null
      },
      /** Return a previously recorded stop reason for the fixture command. */
      stopped: async (cmd) => stops.get(publishCommandKey(cmd)) ?? null,
      /**
       * Accept or reject a fixture publish command under the same claim and
       * authorization checks as production.
       */
      accept: (cmd, now) =>
        atomic(async () => {
          const saved = commands.get(publishCommandKey(cmd))
          if (
            saved &&
            (saved.command.batchId !== cmd.batchId ||
              saved.command.revision !== cmd.revision ||
              !sameRequester(saved.command.requestedBy, cmd.requestedBy))
          )
            return { ok: false, error: 'superseded' }
          cmd = saved?.command ?? cmd
          const { eligibility, claim, receipt, current } = await inspect(
            cmd,
            now,
            !!saved,
            true
          )
          if (!eligibility.canRetry)
            return { ok: false, error: eligibility.reason! }
          if (saved)
            return {
              ok: true,
              command: structuredClone(cmd),
              ...((saved.runId ?? claim?.runId)
                ? { runId: saved.runId ?? claim?.runId }
                : {}),
            }
          if (
            claim &&
            claim.command.commandId !== cmd.commandId &&
            !stops.has(publishCommandKey(claim.command))
          )
            stops.set(publishCommandKey(claim.command), 'superseded')
          if (
            receipt &&
            receipt.commandId !== cmd.commandId &&
            !stops.has(publishCommandKey(receipt))
          )
            stops.set(publishCommandKey(receipt), 'superseded')
          commands.set(
            publishCommandKey(cmd),
            structuredClone({ command: cmd, acceptedAt: now })
          )
          await store.updatePublishMetadata(cmd.batchId, current!.revision, {
            publishCommand: {
              commandId: cmd.commandId!,
              revision: cmd.revision,
            },
          })
          return { ok: true, command: structuredClone(cmd) }
        }),
      /** Attach a workflow ID only while the fixture command still owns its claim. */
      bindRun: (cmd, runId, now) =>
        atomic(async () => {
          const saved = commands.get(publishCommandKey(cmd))
          const current = await store.getBatch(cmd.batchId)
          const receipt = records.get(receiptId(cmd.batchId, cmd.revision))
          if (
            !saved ||
            (saved.runId && saved.runId !== runId) ||
            stops.has(publishCommandKey(cmd))
          )
            return false
          const eligible =
            batchApprovedFor(current, cmd) ||
            (current?.state === 'published' &&
              current.revision === cmd.revision + 1 &&
              receipt &&
              receipt.commandId === cmd.commandId &&
              receipt.committedAt)
          if (
            !eligible ||
            !current ||
            !current.publishCommand ||
            current.publishCommand.commandId !== cmd.commandId ||
            current.publishCommand.revision !== cmd.revision
          )
            return false
          if (
            !(await store.updatePublishMetadata(cmd.batchId, current.revision, {
              approvalRun: { runId, revision: cmd.revision - 1 },
              publishRequestedAt: saved.acceptedAt ?? now,
              publishRequestedBy: cmd.requestedBy,
            }))
          )
            return false
          commands.set(publishCommandKey(cmd), { ...saved, runId })
          return true
        }),
      /**
       * Allow an eligible retry to adopt the fixture receipt while retaining earlier
       * command history.
       */
      adopt: async (record, cmd, checksum, token, now) => {
        if (
          !active(token, now) ||
          lease?.batchId !== cmd.batchId ||
          lease.revision !== cmd.revision
        )
          return 'lock_lost'
        const current = await store.getBatch(cmd.batchId)
        if (!batchApprovedFor(current, cmd) || reservation !== token)
          return 'superseded_revision'
        if (claimSupersedes(current, cmd)) return 'superseded'
        const saved = records.get(record.id)
        if (
          [...records.values()].some(
            (other) =>
              other.id !== record.id &&
              other.toVersion === record.toVersion &&
              occupiesTarget(other)
          )
        )
          return 'version_taken'
        if (
          !saved ||
          saved.commandId !== record.commandId ||
          saved.committedAt ||
          !stops.has(publishCommandKey(saved))
        )
          return 'superseded'
        if (isSuperseded(saved, cmd)) return 'superseded'
        if (
          saved.id !== receiptId(cmd.batchId, cmd.revision) ||
          saved.batchId !== cmd.batchId ||
          saved.revision !== cmd.revision ||
          !validTarget(saved.fromVersion, saved.toVersion) ||
          saved.state === 'abandoned' ||
          burns.has(saved.toVersion) ||
          checksum !== saved.blobSha256 ||
          saved.blobSha256 !== record.blobSha256 ||
          saved.toVersion !== record.toVersion ||
          saved.fromVersion !== record.fromVersion
        )
          return 'version_taken'
        if (
          pointer.version !== saved.fromVersion ||
          saved.fromVersion !== current!.baselineVersion
        )
          return 'stale_baseline'
        const stop = await check(cmd)
        if (stop) return stop
        const adopted: PublishRecord = {
          ...saved,
          ...cmd,
          state: 'started',
          supersededCommands: [
            ...(saved.supersededCommands ?? []),
            {
              batchId: saved.batchId,
              revision: saved.revision,
              commandId: saved.commandId,
              generation: saved.generation,
              requestedBy: saved.requestedBy,
            },
          ],
        }
        records.set(record.id, structuredClone(adopted))
        return adopted
      },
      /**
       * Read an isolated copy of the fixture receipt so callers cannot mutate stored
       * state directly.
       */
      get: async (id) => structuredClone(records.get(id) ?? null),
      /**
       * Save receipt progress while enforcing fixture lease, version and command
       * ownership.
       */
      save: async (record, token, now) => {
        if (!active(token, now)) return false
        const previous = records.get(record.id)
        if (
          burns.has(record.toVersion) ||
          previous?.state === 'abandoned' ||
          record.state === 'abandoned'
        )
          return false
        if (
          !validTarget(record.fromVersion, record.toVersion) ||
          record.id !== receiptId(record.batchId, record.revision)
        )
          return false
        if (
          !previous &&
          [...records.values()].some(
            (other) =>
              other.toVersion === record.toVersion && occupiesTarget(other)
          )
        )
          return false
        if (previous) {
          if (
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
              (key) =>
                previous[key as keyof PublishRecord] !==
                record[key as keyof PublishRecord]
            )
          )
            return false
          if (!sameRequester(previous.requestedBy, record.requestedBy))
            return false
          if (
            (previous.state === 'done' && record.state !== 'done') ||
            (previous.state === 'failed' && record.state !== 'failed') ||
            (previous.state === 'uploaded' && record.state === 'started')
          )
            return false
        }
        if (
          (record.committedAt &&
            record.committedAt !== previous?.committedAt) ||
          (record.state === 'done' && !previous?.committedAt) ||
          (record.state === 'failed' && previous?.committedAt)
        )
          return false
        records.set(
          record.id,
          structuredClone({ ...records.get(record.id), ...record })
        )
        return true
      },
    },
    lock: {
      /**
       * Simulate acquiring the publish lease and optionally freezing the batch's
       * reservation.
       */
      claim: async (claim, now) => {
        if (lease && Date.parse(lease.expiresAt) > Date.parse(now)) return false
        const current = await store.getBatch(claim.batchId)
        if (
          !current ||
          (claim.purpose !== 'abandon' &&
            (current.state !== 'approved' ||
              current.revision !== claim.revision))
        )
          return false
        lease = structuredClone(claim)
        if (claim.purpose !== 'abandon') {
          reservation = claim.token
          reservationBatch = claim.batchId
        }
        return true
      },
      /** Renew a fixture lease only while the submitted token still owns it. */
      renew: async (claim, now) => {
        if (!active(claim.token, now)) return false
        lease = structuredClone(claim)
        return true
      },
      /**
       * Release the matching lease and retain the freeze when the caller requests
       * recovery.
       */
      release: async (token, keepFrozen) => {
        if (lease?.token !== token) return
        if (!keepFrozen) reservation = null
        lease = null
      },
    },
  }
  return {
    /** Map a fixture download URL back to its exact stored object and bytes. */ resolveUrl:
      (url: string) => {
        for (const version of blobs.keys()) {
          const object = objectAt(version)
          if (
            object &&
            url ===
              `https://storage.example/v${version}.json?token=${object.token}`
          )
            return { generation: object.generation, bytes: object.bytes }
        }
        return null
      },
    burns,
    commands,
    /** Replace the current requester identity to simulate authority changing during a release. */ setRequester:
      (value: unknown) => {
        requester = value
      },
    /** Replace the fixture release control so tests can simulate pause and generation changes. */ setControl:
      (value: PublishControlState | null) => {
        control = value
      },
    deps,
    blobs,
    records,
    stateOrder,
    stateOrderVersion,
    /** Expose the current live pointer for assertions about the committed version. */ pointer:
      () => pointer,
    /** Expose the current publish lease for lock and recovery assertions. */ lease:
      () => lease,
    /** Set the fixture clock to exercise expiry and timing boundaries immediately. */ setTime:
      (value: string) => {
        time = value
      },
  }
}

/** Seed the standard-plate edits needed to publish a batch with state order changes. */
export async function seedOrderStandards(
  d: Pick<PublishDeps, 'store' | 'snapshots'>,
  batchId: string
) {
  const batch = (await d.store.getBatch(batchId))!
  const snapshot = await d.snapshots.read(batch.baselineVersion)
  const edits = Object.entries(batch.stateOrders).flatMap(([state, order]) =>
    snapshot.plates
      .filter((plate) => plate.state === state)
      .map((plate) => ({
        plateId: plate.id,
        baseRevision: '',
        fields: {
          isStandard: plate.id === order[0],
          ...(plate.id === order[0]
            ? { templateRole: 'template' as const }
            : {}),
        },
        authorId: 'editor',
        updatedAt: '',
        resultRevision: '',
      }))
  )
  await d.store.commit(batch.id, batch.revision, {
    batch: {
      ...batch,
      plateIds: [
        ...new Set([...batch.plateIds, ...edits.map((edit) => edit.plateId)]),
      ],
    },
    edits,
  })
}
