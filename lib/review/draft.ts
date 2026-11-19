import { createHash } from 'node:crypto'
import type { DraftChange } from './checkpoint'
import { isRelease, isSharedDraft, sharedDraftId } from './draft-id'
import { hasDraftChanges } from '../publish/command'
import { retainedPipelineChanges } from './pipeline-changes'
import { draftCommitAttempts, draftRetryPause } from './retry'
import { plateRevision } from './revision'
import { sameEditableValue } from './story'
import { sortedJsonValue } from './canonical-value'
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
  const held = draftHolds(head.batch, revision, head.batch.baselineVersion)
  if (!held.ok) return held
  const existing = await d.store.getBatch(id)
  if (existing) return { ok: true, value: existing }
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

/**
 * Whether the draft's head still lets a release of `revision` on `baselineVersion` be
 * accepted: the draft has no conflicts waiting for the Owner, and the revision is one it
 * can still publish on that baseline. An existing freeze is checked too, because a
 * rollback can bring an old freeze's baseline back while the round trip left conflicts.
 */
function draftHolds(
  head: ReviewBatch,
  revision: number,
  baselineVersion: number
):
  | { ok: true }
  | { ok: false; error: 'draft_conflicts' | 'superseded_revision' } {
  if (head.conflicts?.length) return { ok: false, error: 'draft_conflicts' }
  if (
    revision > head.revision ||
    revision < (head.rebaseFloor ?? 0) ||
    baselineVersion !== head.baselineVersion
  )
    return { ok: false, error: 'superseded_revision' }
  return { ok: true }
}

/**
 * Check an unaccepted release against its draft before a new Publish command accepts
 * it, at whichever entry point the command came through. The draft is settled onto live
 * first, so a release frozen before an outside change waits for the Owner's review and
 * one frozen before a rebase is superseded. A command already accepted replays without
 * this check.
 */
export async function releaseAcceptable(
  d: ReviewDeps,
  release: ReviewBatch
): Promise<
  | { ok: true }
  | {
      ok: false
      error: 'not_found' | 'draft_conflicts' | 'superseded_revision'
    }
> {
  if (!release.source) return { ok: false, error: 'not_found' }
  const settled = await settleDraft(d, release.source.batchId)
  if (!settled.ok)
    return {
      ok: false,
      error:
        settled.error === 'not_found' ? 'not_found' : 'superseded_revision',
    }
  return draftHolds(
    settled.value,
    release.source.revision,
    release.baselineVersion
  )
}

/** How many publishes a rebase traces back before treating the rest as one outside move. */
const traceLimit = 20

/**
 * One move of the live pointer, with the committed publish that made it when known.
 * `uncertain` marks an outside move whose span holds publishes the receipts cannot
 * place in order.
 */
type CatalogMove = {
  from: number
  to: number
  origin: VersionOrigin | null
  uncertain?: true
}

/**
 * Trace how live moved from the draft's baseline to `to`, one committed publish at a
 * time, oldest first. Returns 'settling' while a publish on the way has moved the
 * pointer but not finished, so its release and state order projection are not final.
 *
 * Tracing runs back from `to` until a version no receipt explains (an outside change to
 * the pointer). The versions before it are then searched for committed publishes, so a
 * release that shipped before the outside change is still replayed as itself and its
 * put-backs survive. When those publishes do not chain (the pointer went back between
 * them) or the gap is too long to search, the span becomes one uncertain outside move:
 * the draft stays on its baseline, untouched, until the Owner reviews it.
 */
async function catalogMoves(
  origin: (version: number) => Promise<VersionOrigin | null>,
  from: number,
  to: number
): Promise<CatalogMove[] | 'settling'> {
  const moves: CatalogMove[] = []
  let at = to
  let unexplained = false
  for (let step = 0; step < traceLimit && at !== from; step += 1) {
    const found = await origin(at)
    if (!found || found.toVersion !== at) {
      unexplained = true
      break
    }
    if (found.fromVersion < from || found.fromVersion >= at) {
      return [{ from, to, origin: null, uncertain: true }]
    }
    if (!found.settled) return 'settling'
    moves.unshift({ from: found.fromVersion, to: at, origin: found })
    at = found.fromVersion
  }
  if (at === from) return moves
  if (!unexplained || at < from || at - from - 1 > traceLimit)
    return [{ from, to, origin: null, uncertain: true }]
  const gap: CatalogMove[] = []
  let current = from
  for (let version = from + 1; version < at; version += 1) {
    const found = await origin(version)
    if (!found || found.toVersion !== version) continue
    if (found.fromVersion < current || found.fromVersion >= version)
      return [{ from, to, origin: null, uncertain: true }]
    if (!found.settled) return 'settling'
    if (found.fromVersion > current)
      gap.push({ from: current, to: found.fromVersion, origin: null })
    gap.push({ from: found.fromVersion, to: version, origin: found })
    current = version
  }
  return [...gap, { from: current, to: at, origin: null }, ...moves]
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
 * When the receipts cannot trace the span, the draft is not moved: its baseline, edits
 * and history stay as they are, and a catalog conflict lists the span and every value
 * the draft put back after a release that may have published, until the Owner keeps the
 * draft's values.
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
    // Once the receipts could not trace the span, the draft waits for the Owner, even
    // if a later pointer move would trace again.
    const holding = batch.conflicts?.some(
      (conflict) => conflict.kind === 'catalog'
    )
    const moves = holding
      ? null
      : await catalogMoves(origin, batch.baselineVersion, live)
    if (moves === 'settling') return unchanged
    if (!moves || moves.some((move) => move.uncertain)) {
      const conflicts = [
        ...(batch.conflicts ?? []).filter(
          (conflict) => conflict.kind !== 'catalog'
        ),
        await catalogHold(d, head, live),
      ]
      if (
        JSON.stringify(sortedJsonValue(conflicts)) ===
        JSON.stringify(sortedJsonValue(batch.conflicts ?? []))
      )
        return unchanged
      const next: ReviewBatch = {
        ...batch,
        revision: batch.revision + 1,
        conflicts,
      }
      const result = await d.store.commit(batch.id, batch.revision, {
        batch: next,
        history: false,
      })
      if (result === 'revision_mismatch') continue
      if (result !== 'ok') return { ok: false, error: result }
      return { ...unchanged, value: next, changed: true }
    }
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
 * The conflict that holds the draft on its baseline when the receipts cannot trace how
 * live moved. A release of the draft from this baseline that was accepted (and not
 * abandoned) may have published, so live may now hold a value the draft put back after
 * freezing it. Each such put-back is listed with the value the draft wants, for the
 * Owner to decide, instead of being guessed.
 */
async function catalogHold(
  d: ReviewDeps,
  head: DraftSnapshot,
  live: number
): Promise<DraftConflict> {
  const { batch } = head
  const releases = (
    await d.store.list({ states: ['approved', 'published'] })
  ).filter(
    (release) =>
      isRelease(release) &&
      release.source?.batchId === batch.id &&
      release.baselineVersion === batch.baselineVersion &&
      !release.publishAbandonment
  )
  const pending = new Map(head.edits.map((edit) => [edit.plateId, edit]))
  const resets = new Map<string, EditableFields>()
  const orderResets: Record<string, string[]> = {}
  for (const release of releases) {
    for (const published of await d.store.listEdits(release.id)) {
      const kept = pending.get(published.plateId)?.fields ?? {}
      const old = await d.baselineAtVersion(
        batch.baselineVersion,
        published.plateId
      )
      for (const [key, value] of Object.entries(published.fields)) {
        if (Object.hasOwn(kept, key)) continue
        const before = old?.[key as keyof typeof old]
        if (sameLiveValue(key, value, before)) continue
        resets.set(published.plateId, {
          ...resets.get(published.plateId),
          [key]: before === undefined ? clearedValue(key) : before,
        })
      }
    }
    for (const [state, order] of Object.entries(release.stateOrders ?? {})) {
      if (Object.hasOwn(batch.stateOrders ?? {}, state)) continue
      const before =
        release.baselineOrders?.[state] ??
        (await stateIds(d, batch.baselineVersion, state, 'snapshot'))
      if (!sameList(before, order)) orderResets[state] = before
    }
  }
  return {
    kind: 'catalog',
    fromVersion: batch.baselineVersion,
    toVersion: live,
    ...(resets.size
      ? {
          resets: [...resets]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([plateId, fields]) => ({ plateId, fields })),
        }
      : {}),
    ...(Object.keys(orderResets).length ? { orderResets } : {}),
  }
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

/** A state's plate ids in the given order source at a catalog version. */
async function stateIds(
  d: ReviewDeps,
  version: number,
  state: string,
  order?: 'snapshot'
) {
  return (await d.stateBaseline(version, state, order)).map((plate) => plate.id)
}

/** Ids of `order` that `other` also lists, in `order`'s sequence. */
function shared(order: string[], other: string[]) {
  const ids = new Set(other)
  return order.filter((id) => ids.has(id))
}

/**
 * A state's order on live right after a move. The curator order is not versioned (it
 * holds the latest projection), so a committed publish is replayed from its immutable
 * Snapshot order when it shipped an order for the state, and otherwise keeps the order
 * live had before it. An outside move has no record, so it reads the curator order.
 */
async function orderAfter(
  d: ReviewDeps,
  move: CatalogMove,
  state: string,
  release: DraftSnapshot | undefined,
  before: string[] | undefined
) {
  if (!move.origin) return stateIds(d, move.to, state)
  const after = await stateIds(d, move.to, state, 'snapshot')
  const shipped = release
    ? Object.hasOwn(release.batch.stateOrders ?? {}, state)
    : await stateIds(d, move.from, state, 'snapshot').then(
        (prior) => !sameList(shared(prior, after), shared(after, prior))
      )
  if (shipped) return after
  return before ? orderOnto(before, after) : stateIds(d, move.to, state)
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
      else if (edit && !edit.fields.deleted) {
        // Keep what the draft would have published so the Owner sees the loss.
        conflicts.push({
          kind: 'removed',
          plateId,
          fields: omit(edit.fields, 'deleted'),
          fromVersion: from,
          toVersion: to,
        })
        warnings.push(`Plate no longer in the catalog: ${plateId}`)
      }
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
    const live = await orderAfter(
      d,
      move,
      state,
      release,
      working.baselineOrders[state] ?? release?.batch.baselineOrders?.[state]
    )
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
  // A removed plate or an untraceable catalog move has nothing left to edit; only the
  // Owner's keep clears them.
  const left = batch.conflicts.filter((conflict) =>
    'state' in resolved
      ? !(conflict.kind === 'order' && conflict.state === resolved.state)
      : conflict.kind === 'order' ||
        conflict.kind === 'removed' ||
        conflict.kind === 'catalog' ||
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
  const head = await d.store.readBatch(input.batchId)
  if (!head || !isSharedDraft(head.batch))
    return { ok: false, error: 'not_found' }
  const { batch } = head
  if (batch.revision !== input.revision)
    return { ok: false, error: 'superseded_revision' }
  if (!batch.conflicts?.length) return { ok: true, value: batch }
  const held = batch.conflicts.find((conflict) => conflict.kind === 'catalog')
  const write = held
    ? await reconcileCatalog(d, actor, head, held)
    : {
        batch: {
          ...omit(batch, 'conflicts'),
          revision: batch.revision + 1,
          lastChangedAt: d.now(),
        },
      }
  const next = write.batch
  const result = await d.store.commit(batch.id, batch.revision, {
    ...write,
    by: actor,
  })
  if (result === 'revision_mismatch')
    return { ok: false, error: 'superseded_revision' }
  if (result !== 'ok') return { ok: false, error: result }
  return { ok: true, value: next }
}

/**
 * The Owner's review of a span the receipts could not trace. The put-backs it listed
 * join the draft's values, and the draft moves onto live as after an outside change,
 * keeping every pending value without asking again about the span. Plates live no
 * longer has stay as conflicts, so the Owner sees what cannot be published.
 */
async function reconcileCatalog(
  d: ReviewDeps,
  actor: Actor,
  head: DraftSnapshot,
  held: Extract<DraftConflict, { kind: 'catalog' }>
) {
  const { batch } = head
  const live = d.liveVersion ? await d.liveVersion() : batch.baselineVersion
  const now = d.now()
  const edits = new Map(head.edits.map((edit) => [edit.plateId, edit]))
  for (const reset of held.resets ?? []) {
    const edit = edits.get(reset.plateId)
    edits.set(reset.plateId, {
      ...(edit ?? {
        plateId: reset.plateId,
        authorId: actor.uid,
        authorName: actor.name,
        baseRevision: '',
        resultRevision: '',
      }),
      fields: { ...reset.fields, ...edit?.fields },
      updatedAt: now,
    })
  }
  const stateOrders = structuredClone(batch.stateOrders ?? {})
  const baselineOrders = structuredClone(batch.baselineOrders ?? {})
  for (const [state, order] of Object.entries(held.orderResets ?? {})) {
    if (Object.hasOwn(stateOrders, state)) continue
    stateOrders[state] = [...order]
    baselineOrders[state] = [...order]
  }
  const moved = await moveOnto(
    d,
    { edits, stateOrders, baselineOrders, conflicts: [], warnings: [] },
    { from: batch.baselineVersion, to: live, origin: null }
  )
  const conflicts = moved.conflicts.filter(
    (conflict) => conflict.kind === 'removed' || conflict.kind === 'deleted'
  )
  const before = new Map(head.edits.map((edit) => [edit.plateId, edit]))
  const next: ReviewBatch = {
    ...omit(batch, 'pipelineApplications', 'conflicts'),
    revision: batch.revision + 1,
    lastChangedAt: now,
    baselineVersion: live,
    stateOrders: moved.stateOrders,
    baselineOrders: moved.baselineOrders,
    stateOrderChangedAt: Object.fromEntries(
      Object.entries(batch.stateOrderChangedAt ?? {}).filter(
        ([state]) => state in moved.stateOrders
      )
    ),
    plateIds: trackedPlateIds(batch.plateIds, moved.edits.keys()),
    rebaseFloor: batch.revision + 1,
    ...(conflicts.length ? { conflicts } : {}),
  }
  return {
    batch: next,
    edits: [...moved.edits.values()].filter(
      (edit) => edit !== before.get(edit.plateId)
    ),
    deleteEditsFor: [...before.keys()].filter(
      (plateId) => !moved.edits.has(plateId)
    ),
    history: false as const,
  }
}

/**
 * The release that will delete this plate from the catalog, if one from the draft's
 * current baseline is publishing or waits for Retry or Abandon. Undoing that deletion
 * now could not be carried past the publish, so it is refused until the release
 * finishes or is abandoned. A release whose run ended before preparing a Snapshot holds
 * nothing, as in the Publish view, so the deletion can be undone before it is retried.
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
  for (const release of releases) {
    if (!(await d.store.getEdit(release.id, plateId))?.fields.deleted) continue
    // A published release already removed the plate; the draft settles onto it first.
    const holds =
      release.state === 'published' ||
      !d.releaseActivity ||
      (await d.releaseActivity(release)) !== null
    if (holds)
      return `Revision ${release.source!.revision}, which deletes this plate, is publishing or waiting for recovery. Undo the deletion after that Publish finishes or is abandoned.`
  }
  return null
}
