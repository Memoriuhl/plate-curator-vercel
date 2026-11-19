import { createHash } from 'node:crypto'
import type { DraftChange } from './checkpoint'
import { isRelease, isSharedDraft, sharedDraftId } from './draft-id'
import { hasDraftChanges } from '../publish/command'
import { retainedPipelineChanges } from './pipeline-changes'
import { draftCommitAttempts, draftRetryPause } from './retry'
import { plateRevision } from './revision'
import { sameEditableValue } from './story'
import { draftWriteBudget, writeBytes } from './write-budget'
import type {
  Actor,
  DraftConflict,
  EditableFields,
  LastPublish,
  Outcome,
  ProposedEdit,
  ReviewBatch,
  ReviewDeps,
  VersionOrigin,
} from './types'

export type DraftSnapshot = { batch: ReviewBatch; edits: ProposedEdit[] }
export type DraftAtRevision =
  | ({ ok: true } & DraftSnapshot)
  | { ok: false; reason: 'ahead' | 'below_floor' | 'history_missing' }
export type RebaseOutcome =
  | {
      ok: true
      value: ReviewBatch
      changed: boolean
      dropped: string[]
      warnings: string[]
    }
  | { ok: false; error: 'not_found' | 'superseded_revision' | 'pipeline_busy' }
export type FreezeOutcome =
  | { ok: true; value: ReviewBatch }
  | {
      ok: false
      error:
        | 'not_found'
        | 'superseded_revision'
        | 'empty_draft'
        | 'draft_conflicts'
        | 'draft_too_large'
    }

export const sameList = (left?: string[] | null, right?: string[] | null) =>
  (left ?? null) === (right ?? null) ||
  (!!left &&
    !!right &&
    left.length === right.length &&
    left.every((id, index) => id === right[index]))

/** Copy an object without the named keys. */
export function omit<T extends object, K extends keyof T>(
  value: T,
  ...keys: K[]
): Omit<T, K> {
  const copy = { ...value }
  for (const key of keys) delete copy[key]
  return copy
}

/**
 * Compare a draft value with the live catalog the way Publish writes it: a cleared value
 * (`null`) and a missing one are the same, and `deleted: false` is no deletion.
 */
export function sameLiveValue(key: string, value: unknown, live: unknown) {
  if (key === 'deleted') return !value === !live
  return sameEditableValue(key, value ?? null, live ?? null)
}

/** Keep a saved order's sequence for plates that still exist and append new plates. */
export function orderOnto(order: string[], live: string[]) {
  const ids = new Set(live)
  const kept = order.filter((id) => ids.has(id))
  const seen = new Set(kept)
  return [...kept, ...live.filter((id) => !seen.has(id))]
}

/** Plate ids the draft tracks: every plate with an edit, head order first. */
export function trackedPlateIds(previous: string[], edits: Iterable<string>) {
  const ids = new Set(edits)
  return [
    ...previous.filter((id) => ids.has(id)),
    ...[...ids].filter((id) => !previous.includes(id)),
  ]
}

/** Start a new, empty shared draft on the live catalog version. */
export function newSharedDraft(
  env: string,
  version: number,
  actor: Pick<Actor, 'uid' | 'name'>,
  now: string
): ReviewBatch {
  return {
    id: sharedDraftId(env),
    kind: 'shared-draft',
    name: 'Shared draft',
    createdBy: actor.uid,
    createdByName: actor.name,
    createdAt: now,
    lastChangedAt: now,
    state: 'open',
    revision: 0,
    baselineVersion: version,
    approval: null,
    stateOrders: {},
    baselineOrders: {},
    plateIds: [],
    rebaseFloor: 0,
  }
}

/**
 * Return the environment's shared draft, creating it on first use and moving it onto the
 * live catalog version when a publish (or anything else) moved live since its baseline.
 * While a publish has moved the pointer but not finished, the draft stays where it is
 * until that publish settles.
 */
export async function ensureDraft(
  d: ReviewDeps,
  env: string,
  actor: Pick<Actor, 'uid' | 'name'>
): Promise<ReviewBatch> {
  if (!d.liveVersion) throw new Error('Live catalog version unavailable')
  const id = sharedDraftId(env)
  let batch = await d.store.getBatch(id)
  if (!batch) {
    const fresh = newSharedDraft(env, await d.liveVersion(), actor, d.now())
    batch =
      (await d.store.create(fresh)) === 'ok'
        ? fresh
        : await d.store.getBatch(id)
    if (!batch) throw new Error('Shared draft unavailable')
  }
  const settled = await settleDraft(d, id)
  return settled.ok ? settled.value : batch
}

/**
 * Rebuild the draft as it was at an earlier revision by undoing the change log from the
 * head down. Fails when the revision is newer than the head, below the last rebase, or a
 * change on the way has no before-image.
 */
export function draftAtRevision(
  head: DraftSnapshot,
  changes: DraftChange[],
  revision: number
): DraftAtRevision {
  if (revision > head.batch.revision) return { ok: false, reason: 'ahead' }
  if (revision < (head.batch.rebaseFloor ?? 0))
    return { ok: false, reason: 'below_floor' }
  const undo = changes
    .filter(
      (change) =>
        change.revision > revision && change.revision <= head.batch.revision
    )
    .sort((left, right) => right.revision - left.revision)
  if (undo.some((change) => !change.before))
    return { ok: false, reason: 'history_missing' }
  const edits = new Map(
    head.edits.map((edit) => [edit.plateId, structuredClone(edit)])
  )
  const stateOrders = structuredClone(head.batch.stateOrders ?? {})
  const baselineOrders = structuredClone(head.batch.baselineOrders ?? {})
  for (const change of undo) {
    const before = change.before!
    for (const [plateId, edit] of Object.entries(before.edits)) {
      if (edit) edits.set(plateId, structuredClone(edit))
      else edits.delete(plateId)
    }
    for (const [state, order] of Object.entries(before.stateOrders)) {
      if (order) stateOrders[state] = [...order]
      else delete stateOrders[state]
    }
    for (const [state, order] of Object.entries(before.baselineOrders)) {
      if (order) baselineOrders[state] = [...order]
      else delete baselineOrders[state]
    }
  }
  const stateOrderChangedAt = Object.fromEntries(
    Object.entries(head.batch.stateOrderChangedAt ?? {}).filter(
      ([state]) => state in stateOrders
    )
  )
  return {
    ok: true,
    batch: {
      ...head.batch,
      revision,
      stateOrders,
      baselineOrders,
      stateOrderChangedAt,
      plateIds: trackedPlateIds(head.batch.plateIds, edits.keys()),
    },
    edits: [...edits.values()],
  }
}

/**
 * Name the release made from one draft revision. The same environment, baseline and
 * revision always give the same id, so a retry or double click reuses it.
 */
export function releaseId(
  env: string,
  draftId: string,
  baselineVersion: number,
  revision: number
) {
  return `release-${createHash('sha256')
    .update(JSON.stringify([env, draftId, baselineVersion, revision]))
    .digest('hex')}`
}

/**
 * Freeze the draft at the revision the Owner reviewed into a release batch, which then
 * goes through the existing Owner publish path. Curators keep editing the draft while it
 * publishes, because the publish lock is held on the release, not the draft.
 */
export async function freezeRelease(
  d: ReviewDeps,
  env: string,
  actor: Pick<Actor, 'uid' | 'name'>,
  revision: number
): Promise<FreezeOutcome> {
  const draftId = sharedDraftId(env)
  const head = await d.store.readBatch(draftId)
  if (!head || !isSharedDraft(head.batch))
    return { ok: false, error: 'not_found' }
  const id = releaseId(env, draftId, head.batch.baselineVersion, revision)
  const existing = await d.store.getBatch(id)
  if (existing) return { ok: true, value: existing }
  if (head.batch.conflicts?.length)
    return { ok: false, error: 'draft_conflicts' }
  const changes =
    revision < head.batch.revision && d.store.listChanges
      ? await d.store.listChanges(draftId, revision)
      : []
  const at = draftAtRevision(head, changes, revision)
  if (!at.ok) return { ok: false, error: 'superseded_revision' }
  if (
    !hasDraftChanges(
      at.batch,
      at.edits.map((edit) => edit.fields)
    )
  )
    return { ok: false, error: 'empty_draft' }
  const now = d.now()
  const release: ReviewBatch = {
    id,
    kind: 'release',
    name: `Draft revision ${revision}`,
    createdBy: actor.uid,
    createdByName: actor.name,
    createdAt: now,
    lastChangedAt: now,
    state: 'open',
    revision: 0,
    baselineVersion: at.batch.baselineVersion,
    approval: null,
    source: { batchId: draftId, revision },
    plateIds: at.batch.plateIds,
    stateOrders: at.batch.stateOrders,
    baselineOrders: at.batch.baselineOrders ?? {},
    stateOrderChangedAt: at.batch.stateOrderChangedAt ?? {},
  }
  const edits = at.edits.map((edit) => omit(edit, 'revision'))
  // The release is written in one request, which Firestore caps at 10 MiB.
  if (writeBytes([release, ...edits]) > draftWriteBudget)
    return { ok: false, error: 'draft_too_large' }
  if ((await d.store.create(release, edits)) === 'ok')
    return { ok: true, value: release }
  const raced = await d.store.getBatch(id)
  return raced ? { ok: true, value: raced } : { ok: false, error: 'not_found' }
}

/** How many publishes a rebase traces back before treating the rest as one outside move. */
const traceLimit = 20

/** One move of the live pointer, with the committed publish that made it when known. */
type CatalogMove = { from: number; to: number; origin: VersionOrigin | null }

/**
 * Trace how live moved from the draft's baseline to `to`, one committed publish at a
 * time, oldest first. A version no receipt explains (an outside change to the pointer)
 * ends the trace and the rest becomes one outside move. Returns 'settling' while a
 * publish on the way has moved the pointer but not finished, so its release and state
 * order projection are not final yet.
 */
async function catalogMoves(
  origin: (version: number) => Promise<VersionOrigin | null>,
  from: number,
  to: number
): Promise<CatalogMove[] | 'settling'> {
  const moves: CatalogMove[] = []
  let at = to
  for (let step = 0; step < traceLimit && at !== from; step += 1) {
    const found = await origin(at)
    if (
      !found ||
      found.toVersion !== at ||
      found.fromVersion < from ||
      found.fromVersion >= at
    )
      break
    if (!found.settled) return 'settling'
    moves.unshift({ from: found.fromVersion, to: at, origin: found })
    at = found.fromVersion
  }
  if (at !== from) moves.unshift({ from, to: at, origin: null })
  return moves
}

/** The draft's own release that made a move, or undefined for any other publish. */
async function releaseFor(
  d: ReviewDeps,
  draftId: string,
  move: CatalogMove
): Promise<DraftSnapshot | undefined> {
  if (!move.origin) return undefined
  const snapshot = await d.store.readBatch(move.origin.batchId)
  return snapshot &&
    isRelease(snapshot.batch) &&
    snapshot.batch.source?.batchId === draftId &&
    snapshot.batch.baselineVersion === move.from
    ? snapshot
    : undefined
}

/** Record who published which draft revision, from the receipt that moved the pointer. */
function lastPublishOf(
  release: DraftSnapshot,
  origin: VersionOrigin
): LastPublish {
  return {
    releaseId: release.batch.id,
    revision: release.batch.source?.revision ?? 0,
    version: origin.toVersion,
    // Receipts from before requesters were recorded name no one; fall back to the creator.
    by: origin.by || release.batch.createdBy,
    byName: origin.by ? origin.byName : release.batch.createdByName,
    at: origin.at,
  }
}

/**
 * Move the draft onto the live catalog version. Values that live now has are dropped;
 * values made after a published revision stay for the next Publish.
 *
 * Each step is checked against the receipt that made it. For the draft's own release, a
 * field or order the release published but the draft has since put back keeps the old
 * value, because the put-back came after the published revision. For any other move
 * (an old Batch, another environment, an outside change), a pending value whose field
 * live also changed is kept and recorded as a conflict for the Owner.
 *
 * The draft is read before the pointer and committed against its revision, so a rebase
 * that read an older pointer can never move a newer draft backward.
 */
export async function settleDraft(
  d: ReviewDeps,
  draftId: string,
  fallback?: { release: DraftSnapshot; version: number }
): Promise<RebaseOutcome> {
  const origin = async (version: number) =>
    d.versionOrigin
      ? d.versionOrigin(version)
      : fallback && version === fallback.version
        ? fallbackOrigin(d, fallback.release, version)
        : null
  for (let attempt = 0; attempt < draftCommitAttempts; attempt += 1) {
    await draftRetryPause(attempt)
    const head = await d.store.readBatch(draftId)
    if (!head || !isSharedDraft(head.batch))
      return { ok: false, error: 'not_found' }
    const { batch } = head
    const live = d.liveVersion ? await d.liveVersion() : fallback?.version
    const unchanged = {
      ok: true as const,
      value: batch,
      changed: false,
      dropped: [],
      warnings: [],
    }
    if (live === undefined || batch.baselineVersion === live) return unchanged
    const moves = await catalogMoves(origin, batch.baselineVersion, live)
    if (moves === 'settling') return unchanged
    let working: Working = {
      edits: new Map(head.edits.map((edit) => [edit.plateId, edit])),
      stateOrders: structuredClone(batch.stateOrders ?? {}),
      baselineOrders: structuredClone(batch.baselineOrders ?? {}),
      conflicts: [...(batch.conflicts ?? [])],
      warnings: [],
    }
    let published: { release: DraftSnapshot; origin: VersionOrigin } | null =
      null
    for (const move of moves) {
      const release = await releaseFor(d, draftId, move)
      working = await moveOnto(d, working, move, release)
      if (release && move.origin) published = { release, origin: move.origin }
    }
    const before = new Map(head.edits.map((edit) => [edit.plateId, edit]))
    const dropped = [...before.keys()].filter(
      (plateId) => !working.edits.has(plateId)
    )
    const edits = [...working.edits.values()].filter(
      (edit) => edit !== before.get(edit.plateId)
    )
    const stateOrderChangedAt = Object.fromEntries(
      Object.entries(batch.stateOrderChangedAt ?? {}).filter(
        ([state]) => state in working.stateOrders
      )
    )
    const rest = omit(batch, 'pipelineApplications', 'conflicts')
    const next: ReviewBatch = {
      ...rest,
      revision: batch.revision + 1,
      baselineVersion: live,
      stateOrders: working.stateOrders,
      baselineOrders: working.baselineOrders,
      stateOrderChangedAt,
      plateIds: trackedPlateIds(batch.plateIds, working.edits.keys()),
      rebaseFloor: batch.revision + 1,
      ...(working.conflicts.length ? { conflicts: working.conflicts } : {}),
      ...(published
        ? { lastPublish: lastPublishOf(published.release, published.origin) }
        : {}),
    }
    const result = await d.store.commit(batch.id, batch.revision, {
      batch: next,
      edits,
      deleteEditsFor: dropped,
      history: false,
    })
    if (result === 'revision_mismatch') continue
    if (result !== 'ok') return { ok: false, error: result }
    const through = published?.release.batch.source?.revision
    if (through !== undefined) await d.store.pruneChanges?.(draftId, through)
    return {
      ok: true,
      value: next,
      changed: true,
      dropped,
      warnings: working.warnings,
    }
  }
  return { ok: false, error: 'superseded_revision' }
}

/**
 * Stand in for the receipt when the deps cannot read publish receipts: the release and
 * the version its publish reported.
 */
function fallbackOrigin(
  d: ReviewDeps,
  release: DraftSnapshot,
  version: number
): VersionOrigin {
  return {
    batchId: release.batch.id,
    revision: release.batch.revision,
    fromVersion: release.batch.baselineVersion,
    toVersion: version,
    by: release.batch.createdBy,
    byName: release.batch.createdByName,
    at: d.now(),
    settled: true,
  }
}

/** The draft's edits, orders and conflicts while a rebase steps through moves. */
type Working = {
  edits: Map<string, ProposedEdit>
  stateOrders: Record<string, string[]>
  baselineOrders: Record<string, string[]>
  conflicts: DraftConflict[]
  warnings: string[]
}

/** The value that clears a field the old baseline did not have. */
export function clearedValue(key: string): unknown {
  if (key === 'tags' || key === 'funFacts' || key === 'readMore') return []
  if (key === 'isStandard' || key === 'deleted') return false
  return null
}

/** Apply one catalog move to the working draft. */
async function moveOnto(
  d: ReviewDeps,
  working: Working,
  move: CatalogMove,
  release?: DraftSnapshot
): Promise<Working> {
  const { from, to } = move
  const releaseEdits = new Map(
    (release?.edits ?? []).map((edit) => [edit.plateId, edit])
  )
  const edits = new Map<string, ProposedEdit>()
  const conflicts = [...working.conflicts]
  const warnings = [...working.warnings]
  const outside = !release
  for (const plateId of new Set([
    ...working.edits.keys(),
    ...releaseEdits.keys(),
  ])) {
    const edit = working.edits.get(plateId)
    const live = await d.baselineAtVersion(to, plateId)
    const published = releaseEdits.get(plateId)?.fields ?? {}
    if (!live) {
      if (published.deleted && !edit?.fields.deleted)
        conflicts.push({
          kind: 'deleted',
          plateId,
          fromVersion: from,
          toVersion: to,
        })
      else if (edit && !edit.fields.deleted)
        warnings.push(`Plate no longer in the catalog: ${plateId}`)
      continue
    }
    const old = await d.baselineAtVersion(from, plateId)
    const fields: EditableFields = {}
    for (const [key, value] of Object.entries(edit?.fields ?? {})) {
      const now = live[key as keyof typeof live]
      if (sameLiveValue(key, value, now)) continue
      Object.assign(fields, { [key]: value })
      if (
        outside &&
        !sameLiveValue(key, old?.[key as keyof typeof old], now) &&
        !conflicts.some(
          (conflict) =>
            conflict.kind === 'field' &&
            conflict.plateId === plateId &&
            conflict.field === key
        )
      )
        conflicts.push({
          kind: 'field',
          plateId,
          field: key,
          fromVersion: from,
          toVersion: to,
        })
    }
    for (const key of Object.keys(published)) {
      if (edit && Object.hasOwn(edit.fields, key)) continue
      const before = old?.[key as keyof typeof old]
      if (sameLiveValue(key, before, live[key as keyof typeof live])) continue
      Object.assign(fields, {
        [key]: before === undefined ? clearedValue(key) : before,
      })
    }
    if (!Object.keys(fields).length) continue
    const plate = { ...live, ...fields }
    const attribution = edit ? retainedPipelineChanges(edit, plate) : {}
    const pipelineChanges = Object.fromEntries(
      Object.entries(attribution.pipelineChanges ?? {}).filter(([key]) =>
        Object.hasOwn(fields, key)
      )
    )
    const base = edit
      ? omit(edit, 'pipelineChanges', 'pipelineRunIds', 'revision')
      : {
          plateId,
          authorId: release!.batch.createdBy,
          authorName: release!.batch.createdByName,
          updatedAt: d.now(),
        }
    const nextEdit: ProposedEdit = {
      ...base,
      fields,
      baseRevision: plateRevision(live),
      resultRevision: plateRevision(plate),
      ...(Object.keys(pipelineChanges).length
        ? {
            pipelineChanges,
            ...(attribution.pipelineRunIds
              ? { pipelineRunIds: attribution.pipelineRunIds }
              : {}),
          }
        : {}),
    }
    edits.set(
      plateId,
      edit &&
        edit.baseRevision === nextEdit.baseRevision &&
        edit.resultRevision === nextEdit.resultRevision &&
        JSON.stringify(edit.fields) === JSON.stringify(nextEdit.fields) &&
        JSON.stringify(edit.pipelineChanges ?? {}) ===
          JSON.stringify(nextEdit.pipelineChanges ?? {})
        ? edit
        : nextEdit
    )
  }

  const stateOrders: Record<string, string[]> = {}
  const baselineOrders: Record<string, string[]> = {}
  for (const state of new Set([
    ...Object.keys(working.stateOrders),
    ...Object.keys(release?.batch.stateOrders ?? {}),
  ])) {
    const saved =
      working.stateOrders[state] ??
      (release?.batch.stateOrders?.[state]
        ? (working.baselineOrders[state] ??
          release.batch.baselineOrders?.[state])
        : undefined)
    if (!saved) continue
    const live = (await d.stateBaseline(to, state)).map((plate) => plate.id)
    if (!live.length) continue
    const order = orderOnto(saved, live)
    if (sameList(order, live)) continue
    stateOrders[state] = order
    baselineOrders[state] = live
    const based = working.baselineOrders[state]
    if (
      outside &&
      working.stateOrders[state] &&
      based &&
      !sameList(based, live) &&
      !conflicts.some(
        (conflict) => conflict.kind === 'order' && conflict.state === state
      )
    )
      conflicts.push({ kind: 'order', state, fromVersion: from, toVersion: to })
  }
  return {
    edits,
    stateOrders,
    baselineOrders,
    conflicts: conflicts.filter((conflict) =>
      conflict.kind === 'field'
        ? Object.hasOwn(
            edits.get(conflict.plateId)?.fields ?? {},
            conflict.field
          )
        : conflict.kind === 'order'
          ? conflict.state in stateOrders
          : true
    ),
    warnings,
  }
}

/**
 * Settle the draft after a release publishes: move it onto the live version, record the
 * publish and prune the change log the release made redundant. Safe to repeat, and a
 * no-op once a later publish has already moved the draft on.
 */
export async function afterPublish(
  d: ReviewDeps,
  releaseBatchId: string,
  version: number
): Promise<RebaseOutcome> {
  const release = await d.store.readBatch(releaseBatchId)
  if (!release || !isRelease(release.batch) || !release.batch.source)
    return { ok: false, error: 'not_found' }
  const draftId = release.batch.source.batchId
  const outcome = await settleDraft(d, draftId, { release, version })
  if (
    outcome.ok &&
    !outcome.changed &&
    outcome.value.lastPublish?.releaseId === release.batch.id
  )
    await d.store.pruneChanges?.(draftId, release.batch.source.revision)
  return outcome
}

/**
 * Return the batch without the conflicts a change resolved: fields it set or discarded on
 * a plate (every field when none are named), or a state order it saved.
 */
export function resolveConflicts(
  batch: ReviewBatch,
  resolved: { plateId: string; fields?: string[] } | { state: string }
): ReviewBatch {
  if (!batch.conflicts?.length) return batch
  const left = batch.conflicts.filter((conflict) =>
    'state' in resolved
      ? !(conflict.kind === 'order' && conflict.state === resolved.state)
      : conflict.kind === 'order' ||
        conflict.plateId !== resolved.plateId ||
        (conflict.kind === 'field' &&
          !!resolved.fields &&
          !resolved.fields.includes(conflict.field))
  )
  const rest = omit(batch, 'conflicts')
  return left.length ? { ...rest, conflicts: left } : rest
}

/**
 * The Owner keeps the draft's pending values over the outside catalog changes recorded
 * as conflicts, so Publish can go ahead. Only for the revision the Owner was shown.
 */
export async function keepDraftValues(
  d: ReviewDeps,
  actor: Actor,
  input: { batchId: string; revision: number }
): Promise<Outcome<ReviewBatch>> {
  if (actor.role !== 'owner') return { ok: false, error: 'forbidden' }
  const batch = await d.store.getBatch(input.batchId)
  if (!batch || !isSharedDraft(batch)) return { ok: false, error: 'not_found' }
  if (batch.revision !== input.revision)
    return { ok: false, error: 'superseded_revision' }
  if (!batch.conflicts?.length) return { ok: true, value: batch }
  const next: ReviewBatch = {
    ...omit(batch, 'conflicts'),
    revision: batch.revision + 1,
    lastChangedAt: d.now(),
  }
  const result = await d.store.commit(batch.id, batch.revision, {
    batch: next,
    by: actor,
  })
  if (result === 'revision_mismatch')
    return { ok: false, error: 'superseded_revision' }
  if (result !== 'ok') return { ok: false, error: result }
  return { ok: true, value: next }
}

/**
 * The confirmed release that will delete this plate from the catalog, if one is
 * publishing from the draft's current baseline. Undoing that deletion now could not be
 * carried past the publish, so it is refused until the release finishes or is
 * abandoned.
 */
export async function deletionPublishing(
  d: ReviewDeps,
  draft: ReviewBatch,
  plateId: string
): Promise<string | null> {
  if (!isSharedDraft(draft)) return null
  const releases = (
    await d.store.list({ states: ['approved', 'published'] })
  ).filter(
    (batch) =>
      isRelease(batch) &&
      batch.source?.batchId === draft.id &&
      batch.baselineVersion === draft.baselineVersion &&
      !batch.publishAbandonment
  )
  for (const release of releases)
    if ((await d.store.getEdit(release.id, plateId))?.fields.deleted)
      return `Revision ${release.source!.revision}, which deletes this plate, is publishing or waiting for recovery. Undo the deletion after that Publish finishes or is abandoned.`
  return null
}
