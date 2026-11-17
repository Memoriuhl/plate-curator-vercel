import { publishRequesterStop, sameRequester } from '../../lib/publish/authority'
import { uploadError } from '../../lib/publish/upload'
import { sameObject, verifyPreparedObject } from '../../lib/publish/object'
import { batchApprovedFor, claimSupersedes, isSuperseded, receiptId } from '../../lib/publish/command'
import { CLAIM_TTL_MS, resolveClaimRun, retryEligibility, terminalRun, type EligibilityInput, type PublishRunLookup } from '../../lib/publish/eligibility'
import type { PublishCommand } from '../../lib/publish/types'
import { createHash } from 'node:crypto'
import type { Snapshot } from '../../lib/catalog/types'
import { createMemoryStore } from '../../lib/review/memory-store'
import type { ReviewBatch } from '../../lib/review/types'
import type { CatalogPointer, PublishDeps, PublishLease, PublishRecord, PublishControlState, PublishStop } from '../../lib/publish/types'
import { publishCommandKey, publishControlStop } from '../../lib/publish/control'

export const owner = { uid: 'owner', name: null, role: 'owner' } as const
export const batch: ReviewBatch = {
  stateOrders: {},
  id: 'batch', name: 'Release', createdBy: 'editor', createdByName: null, createdAt: '2026-11-15T12:00:00Z',
  state: 'approved', revision: 2, baselineVersion: 1, plateIds: ['one'],
  approval: { revision: 1, by: owner.uid, at: '2026-11-15T12:00:00Z' },
}
export const command = { batchId: batch.id, revision: batch.revision, generation: 1, commandId: 'command', requestedBy: { uid: 'owner', email: 'owner@example.com', authorityEpoch: 0 } }
export const snapshot: Snapshot = { version: 1, plates: [
  { id: 'one', state: 'CA', slug: 'one', displayName: 'One', image: 'one.png', tags: ['original'] },
  { id: 'two', state: 'CA', slug: 'two', displayName: 'Two', image: 'two.png', tags: [] },
] }

export function fixture(seed: ReviewBatch = batch, lookup: PublishRunLookup = { findRun: async () => null, runStatus: async () => 'running' }) {
  const store = createMemoryStore([seed])
  const blobs = new Map<number, Uint8Array>([[1, Buffer.from(JSON.stringify(snapshot))]])
  const objects = new Map<number, { bytes: Uint8Array; generation: string; token: string }>()
  let generation = 0
  const objectAt = (version: number) => {
    const bytes = blobs.get(version)
    if (!bytes) return null
    let object = objects.get(version)
    if (object?.bytes !== bytes) {
      object = { bytes, generation: String(++generation), token: object ? `t${version}g${generation}` : `t${version}` }
      objects.set(version, object)
    }
    return object
  }
  const records = new Map<string, PublishRecord>()
  const commands = new Map<string, { command: PublishCommand; acceptedAt: string; runId?: string }>()
  let commandQueue = Promise.resolve()
  const atomic = <T>(run: () => Promise<T>) => {
    const next = commandQueue.then(run)
    commandQueue = next.then(() => {}, () => {})
    return next
  }
  const stateOrder: Record<string, string[]> = { NY: ['existing'] }
  let control: PublishControlState | null = { paused: false, generation: 1, changedBy: { uid: 'owner', email: 'owner@example.com' }, changedAt: '2026-11-16T12:00:00Z' }
  let requester: unknown = { uid: 'owner', role: 'owner', status: 'active', authorityEpoch: 0 }
  const stops = new Map<string, PublishStop>()
  const check = async (cmd: PublishCommand) => {
    if (records.get(`${cmd.batchId}@${cmd.revision}`)?.committedAt) return null
    if (claimSupersedes(await store.getBatch(cmd.batchId), cmd)) return 'superseded' as const
    const key = publishCommandKey(cmd)
    const stopped = stops.get(key)
    if (stopped) return stopped
    const reason = publishControlStop(control, cmd) ?? publishRequesterStop(cmd.requestedBy, requester)
    if (reason) stops.set(key, reason)
    return reason
  }
  let pointer: CatalogPointer = { version: 1 }
  let lease: PublishLease | null = null
  let reservation: string | null = null
  let time = '2026-11-15T12:00:00Z'
  const active = (token: string, now: string) => lease?.token === token && Date.parse(lease.expiresAt) > Date.parse(now)
  const commit = store.commit.bind(store)
  const inspect = async (cmd: PublishCommand, now: string, replay = false) => {
    const current = await store.getBatch(cmd.batchId)
    const receipt = records.get(receiptId(cmd.batchId, cmd.revision)) ?? null
    const pending = current?.publishCommand?.revision === cmd.revision ? current.publishCommand : undefined
    let claim = pending ? commands.get(pending.commandId) ?? { command: { batchId: cmd.batchId, revision: cmd.revision, commandId: pending.commandId }, acceptedAt: new Date(Date.parse(now) - CLAIM_TTL_MS).toISOString() } : undefined
    const claimStop = claim ? stops.get(publishCommandKey(claim.command)) : undefined
    const resolved = claimStop ? { claim, status: undefined } : await resolveClaimRun(claim, lookup)
    claim = resolved.claim
    const approvalRun = current?.approvalRun
    const status = claim ? resolved.status : approvalRun?.revision === cmd.revision - 1 ? await (lookup.runStatus?.(approvalRun.runId) ?? Promise.resolve('running')) : undefined
    const input: EligibilityInput = { command: cmd, batch: current, control, member: requester, liveVersion: (await deps.pointer.read()).version, receipt, claim, claimStop, ownStop: stops.get(publishCommandKey(cmd)), receiptStop: receipt ? stops.get(publishCommandKey(receipt)) : undefined, runStatus: status, now, replay }
    const eligibility = retryEligibility(input)
    if ('recoveredRunId' in resolved && resolved.recoveredRunId && status !== 'not_found' && !terminalRun(status) && claim) {
      commands.set(publishCommandKey(claim.command), structuredClone(claim))
      if (current && batchApprovedFor(current, claim.command)) await store.updatePublishMetadata(current.id, current.revision, { approvalRun: { runId: resolved.recoveredRunId, revision: claim.command.revision - 1 }, publishRequestedAt: claim.acceptedAt, ...(claim.command.requestedBy ? { publishRequestedBy: claim.command.requestedBy } : {}) })
    }
    return { input, eligibility, current, receipt, claim }
  }
  store.commit = async (id, revision, next) => {
    if (reservation && (next.publishToken !== reservation || next.batch.state !== 'published')) return 'revision_mismatch'
    const result = await commit(id, revision, next)
    if (result === 'ok' && next.batch.state === 'published') reservation = null
    return result
  }
  const deps: PublishDeps = {
    control: { read: async () => control, check },
    stateBaseline: async (_version, state) => snapshot.plates.filter(plate => plate.state === state),
    store, baselineAtVersion: async (_version, id) => snapshot.plates.find(plate => plate.id === id) ?? null, baseline: async id => snapshot.plates.find(plate => plate.id === id) ?? null,
    now: () => time, leaseMs: 60000,
    curator: {
      writeStateOrders: async (orders, claim, now) => {
        if (!active(claim.token, now) || lease?.batchId !== claim.batchId || lease.revision !== claim.revision) return 'lock_lost'
        Object.assign(stateOrder, structuredClone(orders))
        return 'ok'
      },
    },
    pointer: {
      read: async () => structuredClone(pointer),
      advance: async (record, claim, now) => {
        if (!active(claim.token, now)) return 'lock_lost'
        const current = await store.getBatch(record.batchId)
        if (current?.revision !== record.revision || current.state !== 'approved') return 'superseded_revision'
        const saved = records.get(record.id)
        if (saved?.commandId !== record.commandId) return 'superseded'
        if (saved?.committedAt) return 'advanced'
        const stop = await check(record)
        if (stop) return stop
        if (saved?.generation !== record.generation || saved?.commandId !== record.commandId) return 'superseded'
        if (pointer.version !== record.fromVersion) return 'pointer_moved'
        if (!record.url) return 'superseded_revision'
        if (!sameObject(saved?.object, record.object)) return 'version_taken'
        if (!await verifyPreparedObject(deps.snapshots, record)) return 'version_taken'
        pointer = { version: record.toVersion, url: record.url, blobSha256: record.blobSha256, publishedAt: now }
        records.set(record.id, { ...record, committedAt: now })
        return 'advanced'
      },
    },
    snapshots: {
      metadata: async version => {
        const object = objectAt(version)
        if (!object) return null
        const url = await deps.snapshots.downloadUrl(version)
        return url ? { generation: object.generation, metageneration: '1', md5Hash: createHash('md5').update(object.bytes).digest('base64'), url } : null
      },
      read: async version => JSON.parse(Buffer.from(blobs.get(version)!).toString()) as Snapshot,
      createOnly: async (version, bytes) => {
        if (blobs.has(version)) return 'exists'
        blobs.set(version, Uint8Array.from(bytes))
        return 'created'
      },
      checksum: async (version, expectedGeneration) => {
        const object = objectAt(version)
        return object && (!expectedGeneration || object.generation === expectedGeneration) ? createHash('sha256').update(object.bytes).digest('hex') : null
      },
      downloadUrl: async version => {
        const object = objectAt(version)
        return object ? `https://storage.example/v${version}.json?token=${object.token}` : null
      },
    },
    records: {
      checkUpload: async (record, cmd, checksum, token, now) => {
        if (!active(token, now)) return 'lock_lost'
        const current = await store.getBatch(cmd.batchId)
        if (current?.state !== 'approved' || current.revision !== cmd.revision || current.approval?.revision !== cmd.revision - 1) return 'superseded_revision'
        if (claimSupersedes(current, cmd)) return 'superseded'
        return uploadError(records.get(record.id) ?? null, record, cmd, checksum, pointer.version, [...records.values()].some(saved => saved.toVersion === record.toVersion && !!saved.committedAt)) ?? await check(cmd)
      },
      eligibility: (cmd, now) => atomic(async () => (await inspect(cmd, now)).eligibility),
      command: async id => {
        const saved = commands.get(id)
        return saved ? structuredClone({ command: saved.command, ...(saved.runId ? { runId: saved.runId } : {}) }) : null
      },
      stopped: async cmd => stops.get(publishCommandKey(cmd)) ?? null,
      accept: (cmd, now) => atomic(async () => {
        const saved = commands.get(publishCommandKey(cmd))
        if (saved && (saved.command.batchId !== cmd.batchId || saved.command.revision !== cmd.revision || !sameRequester(saved.command.requestedBy, cmd.requestedBy))) return { ok: false, error: 'superseded' }
        cmd = saved?.command ?? cmd
        const { eligibility, claim, receipt, current } = await inspect(cmd, now, !!saved)
        if (!eligibility.canRetry) return { ok: false, error: eligibility.reason! }
        if (saved) return { ok: true, command: structuredClone(cmd), ...(saved.runId ?? claim?.runId ? { runId: saved.runId ?? claim?.runId } : {}) }
        if (claim && claim.command.commandId !== cmd.commandId && !stops.has(publishCommandKey(claim.command))) stops.set(publishCommandKey(claim.command), 'superseded')
        if (receipt && receipt.commandId !== cmd.commandId && !stops.has(publishCommandKey(receipt))) stops.set(publishCommandKey(receipt), 'superseded')
        commands.set(publishCommandKey(cmd), structuredClone({ command: cmd, acceptedAt: now }))
        await store.updatePublishMetadata(cmd.batchId, current!.revision, { publishCommand: { commandId: cmd.commandId!, revision: cmd.revision } })
        return { ok: true, command: structuredClone(cmd) }
      }),
      bindRun: (cmd, runId, now) => atomic(async () => {
        const saved = commands.get(publishCommandKey(cmd))
        const current = await store.getBatch(cmd.batchId)
        const receipt = records.get(receiptId(cmd.batchId, cmd.revision))
        if (!saved || saved.runId && saved.runId !== runId || stops.has(publishCommandKey(cmd))) return false
        const eligible = batchApprovedFor(current, cmd) || current?.state === 'published' && current.revision === cmd.revision + 1 && receipt && receipt.commandId === cmd.commandId && receipt.committedAt
        if (!eligible || !current || !current.publishCommand || current.publishCommand.commandId !== cmd.commandId || current.publishCommand.revision !== cmd.revision) return false
        if (!await store.updatePublishMetadata(cmd.batchId, current.revision, { approvalRun: { runId, revision: cmd.revision - 1 }, publishRequestedAt: saved.acceptedAt ?? now, publishRequestedBy: cmd.requestedBy })) return false
        commands.set(publishCommandKey(cmd), { ...saved, runId })
        return true
      }),
      adopt: async (record, cmd, checksum, token, now) => {
        if (!active(token, now) || lease?.batchId !== cmd.batchId || lease.revision !== cmd.revision) return 'lock_lost'
        const current = await store.getBatch(cmd.batchId)
        if (!batchApprovedFor(current, cmd) || reservation !== token) return 'superseded_revision'
        if (claimSupersedes(current, cmd)) return 'superseded'
        const saved = records.get(record.id)
        if (!saved || saved.commandId !== record.commandId || saved.committedAt || !stops.has(publishCommandKey(saved))) return 'superseded'
        if (isSuperseded(saved, cmd)) return 'superseded'
        if (saved.id !== receiptId(cmd.batchId, cmd.revision) || saved.batchId !== cmd.batchId || saved.revision !== cmd.revision || saved.toVersion !== saved.fromVersion + 1 || checksum !== saved.blobSha256 || saved.blobSha256 !== record.blobSha256 || saved.toVersion !== record.toVersion || saved.fromVersion !== record.fromVersion) return 'version_taken'
        if (pointer.version !== saved.fromVersion || saved.fromVersion !== current!.baselineVersion) return 'stale_baseline'
        const stop = await check(cmd)
        if (stop) return stop
        const adopted: PublishRecord = { ...saved, ...cmd, state: 'started', supersededCommands: [...saved.supersededCommands ?? [], { batchId: saved.batchId, revision: saved.revision, commandId: saved.commandId, generation: saved.generation, requestedBy: saved.requestedBy }] }
        records.set(record.id, structuredClone(adopted))
        return adopted
      },
      get: async id => structuredClone(records.get(id) ?? null),
      save: async (record, token, now) => {
        if (!active(token, now)) return false
        const previous = records.get(record.id)
        if (previous && (previous.commandId !== record.commandId || previous.generation !== record.generation)) return false
        records.set(record.id, structuredClone({ ...records.get(record.id), ...record }))
        return true
      },
    },
    lock: {
      claim: async (claim, now) => {
        if (lease && Date.parse(lease.expiresAt) > Date.parse(now)) return false
        const current = await store.getBatch(claim.batchId)
        if (current?.state !== 'approved' || current.revision !== claim.revision) return false
        lease = structuredClone(claim)
        reservation = claim.token
        return true
      },
      renew: async (claim, now) => {
        if (!active(claim.token, now)) return false
        lease = structuredClone(claim)
        return true
      },
      release: async (token, keepFrozen) => {
        if (lease?.token !== token) return
        if (!keepFrozen) reservation = null
        lease = null
      },
    },
  }
  return { resolveUrl: (url: string) => {
    for (const version of blobs.keys()) {
      const object = objectAt(version)
      if (object && url === `https://storage.example/v${version}.json?token=${object.token}`) return { generation: object.generation, bytes: object.bytes }
    }
    return null
  }, commands, setRequester: (value: unknown) => { requester = value }, setControl: (value: PublishControlState | null) => { control = value }, deps, blobs, records, stateOrder, pointer: () => pointer, lease: () => lease, setTime: (value: string) => { time = value } }
}
