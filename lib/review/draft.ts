import { createHash } from 'node:crypto'
import type { DraftChange } from './checkpoint'
import { isRelease, isSharedDraft, sharedDraftId } from './draft-id'
import { hasDraftChanges } from '../publish/command'
import { retainedPipelineChanges } from './pipeline-changes'
import { draftCommitAttempts, draftRetryPause } from './retry'
import { plateRevision } from './revision'
import { sameEditableValue } from './story'
import type {
  Actor,
  EditableFields,
  LastPublish,
  ProposedEdit,
  ReviewBatch,
  ReviewDeps,
} from './types'

export type DraftSnapshot = { batch: ReviewBatch; edits: ProposedEdit[] }
/** A release the catalog now contains, with the version it produced. */
export type PublishedRelease = DraftSnapshot & { version: number; at: string }
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
  | { ok: false; error: 'not_found' | 'superseded_revision' | 'empty_draft' }

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
 */
export async function ensureDraft(
  d: ReviewDeps,
  env: string,
  actor: Pick<Actor, 'uid' | 'name'>
): Promise<ReviewBatch> {
  if (!d.liveVersion) throw new Error('Live catalog version unavailable')
  const id = sharedDraftId(env)
  const live = await d.liveVersion()
  let batch = await d.store.getBatch(id)
  if (!batch) {
    const fresh = newSharedDraft(env, live, actor, d.now())
    batch =
      (await d.store.create(fresh)) === 'ok'
        ? fresh
        : await d.store.getBatch(id)
    if (!batch) throw new Error('Shared draft unavailable')
  }
  if (batch.baselineVersion === live) return batch
  const rebased = await rebaseDraft(
    d,
    id,
    live,
    await publishedRelease(d, batch, live)
  )
  return rebased.ok ? rebased.value : batch
}

/**
 * Find the published release that moved live off this draft's baseline, so a lazy
 * rebase can apply the same release-aware rules as the post-publish step.
 */
async function publishedRelease(
  d: ReviewDeps,
  draft: ReviewBatch,
  version: number
): Promise<PublishedRelease | undefined> {
  const [latest] = (await d.store.list({ states: ['published'] }))
    .filter(
      (batch) =>
        isRelease(batch) &&
        batch.source?.batchId === draft.id &&
        batch.baselineVersion === draft.baselineVersion
    )
    .sort(
      (left, right) =>
        (right.source?.revision ?? 0) - (left.source?.revision ?? 0)
    )
  if (!latest) return undefined
  const snapshot = await d.store.readBatch(latest.id)
  return snapshot ? { ...snapshot, version, at: d.now() } : undefined
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
  if ((await d.store.create(release, edits)) === 'ok')
    return { ok: true, value: release }
  const raced = await d.store.getBatch(id)
  return raced ? { ok: true, value: raced } : { ok: false, error: 'not_found' }
}

/** Record who published which draft revision, as stored on the draft. */
function lastPublishOf(release: PublishedRelease): LastPublish {
  return {
    releaseId: release.batch.id,
    revision: release.batch.source?.revision ?? 0,
    version: release.version,
    by: release.batch.createdBy,
    byName: release.batch.createdByName,
    at: release.at,
  }
}

/**
 * Move the draft onto a newer live catalog version. Values that live now has are
 * dropped; values made after the published revision stay for the next Publish.
 *
 * With the release that produced the new version, a field or order the release
 * published but the draft has since put back to the old baseline keeps that old value,
 * because the put-back happened after the revision that was published.
 */
export async function rebaseDraft(
  d: ReviewDeps,
  draftId: string,
  toVersion: number,
  release?: PublishedRelease
): Promise<RebaseOutcome> {
  for (let attempt = 0; attempt < draftCommitAttempts; attempt += 1) {
    await draftRetryPause(attempt)
    const head = await d.store.readBatch(draftId)
    if (!head || !isSharedDraft(head.batch))
      return { ok: false, error: 'not_found' }
    const { batch } = head
    const recorded =
      !release || batch.lastPublish?.releaseId === release.batch.id
    if (batch.baselineVersion === toVersion && recorded) {
      if (release) await pruneThrough(d, draftId, release)
      return {
        ok: true,
        value: batch,
        changed: false,
        dropped: [],
        warnings: [],
      }
    }
    const fromVersion = batch.baselineVersion
    const moving = fromVersion !== toVersion
    const published =
      moving && release?.batch.baselineVersion === fromVersion
        ? release
        : undefined
    const plan = moving
      ? await rebasePlan(d, head, fromVersion, toVersion, published)
      : {
          edits: [],
          dropped: [],
          warnings: [],
          stateOrders: batch.stateOrders,
          baselineOrders: batch.baselineOrders ?? {},
          plateIds: batch.plateIds,
        }
    const rest = omit(batch, 'pipelineApplications')
    const stateOrderChangedAt = Object.fromEntries(
      Object.entries(batch.stateOrderChangedAt ?? {}).filter(
        ([state]) => state in plan.stateOrders
      )
    )
    const next: ReviewBatch = {
      ...(moving ? rest : batch),
      revision: batch.revision + 1,
      baselineVersion: toVersion,
      stateOrders: plan.stateOrders,
      baselineOrders: plan.baselineOrders,
      stateOrderChangedAt,
      plateIds: plan.plateIds,
      ...(moving ? { rebaseFloor: batch.revision + 1 } : {}),
      ...(release ? { lastPublish: lastPublishOf(release) } : {}),
    }
    const result = await d.store.commit(batch.id, batch.revision, {
      batch: next,
      edits: plan.edits,
      deleteEditsFor: plan.dropped,
      ...(moving ? { history: false as const } : {}),
    })
    if (result === 'revision_mismatch') continue
    if (result !== 'ok') return { ok: false, error: result }
    if (release) await pruneThrough(d, draftId, release)
    return {
      ok: true,
      value: next,
      changed: true,
      dropped: plan.dropped,
      warnings: plan.warnings,
    }
  }
  return { ok: false, error: 'superseded_revision' }
}

/**
 * Drop change-log entries for revisions the release published. Entries after it describe
 * unpublished changes and stay for revert.
 */
async function pruneThrough(
  d: ReviewDeps,
  draftId: string,
  release: PublishedRelease
) {
  const through = release.batch.source?.revision
  if (through !== undefined) await d.store.pruneChanges?.(draftId, through)
}

/** Work out which edits and orders survive the move to the new version. */
async function rebasePlan(
  d: ReviewDeps,
  head: DraftSnapshot,
  fromVersion: number,
  toVersion: number,
  release?: PublishedRelease
) {
  const { batch } = head
  const headEdits = new Map(head.edits.map((edit) => [edit.plateId, edit]))
  const releaseEdits = new Map(
    (release?.edits ?? []).map((edit) => [edit.plateId, edit])
  )
  const edits: ProposedEdit[] = []
  const kept: string[] = []
  const dropped: string[] = []
  const warnings: string[] = []
  for (const plateId of new Set([
    ...headEdits.keys(),
    ...releaseEdits.keys(),
  ])) {
    const edit = headEdits.get(plateId)
    const live = await d.baselineAtVersion(toVersion, plateId)
    if (!live) {
      if (edit) {
        dropped.push(plateId)
        if (!edit.fields.deleted)
          warnings.push(`Plate no longer in the catalog: ${plateId}`)
      }
      continue
    }
    const fields: EditableFields = {}
    for (const [key, value] of Object.entries(edit?.fields ?? {}))
      if (!sameLiveValue(key, value, live[key as keyof typeof live]))
        Object.assign(fields, { [key]: value })
    const published = releaseEdits.get(plateId)?.fields ?? {}
    const restored = Object.keys(published).filter(
      (key) => !edit || !Object.hasOwn(edit.fields, key)
    )
    if (restored.length) {
      const old = await d.baselineAtVersion(fromVersion, plateId)
      for (const key of restored) {
        const value = old?.[key as keyof typeof old]
        if (sameLiveValue(key, value, live[key as keyof typeof live])) continue
        if (value === undefined) {
          warnings.push(`Cannot restore ${key} on ${plateId}`)
          continue
        }
        Object.assign(fields, { [key]: value })
      }
    }
    if (!Object.keys(fields).length) {
      if (edit) dropped.push(plateId)
      continue
    }
    kept.push(plateId)
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
    if (
      !edit ||
      edit.baseRevision !== nextEdit.baseRevision ||
      edit.resultRevision !== nextEdit.resultRevision ||
      JSON.stringify(edit.pipelineChanges ?? {}) !==
        JSON.stringify(nextEdit.pipelineChanges ?? {})
    )
      edits.push(nextEdit)
  }

  const stateOrders: Record<string, string[]> = {}
  const baselineOrders: Record<string, string[]> = {}
  const states = new Set([
    ...Object.keys(batch.stateOrders ?? {}),
    ...Object.keys(release?.batch.stateOrders ?? {}),
  ])
  for (const state of states) {
    const saved =
      batch.stateOrders?.[state] ??
      (release?.batch.stateOrders?.[state]
        ? (batch.baselineOrders?.[state] ??
          release.batch.baselineOrders?.[state])
        : undefined)
    if (!saved) continue
    const live = (await d.stateBaseline(toVersion, state)).map(
      (plate) => plate.id
    )
    if (!live.length) continue
    const order = orderOnto(saved, live)
    if (sameList(order, live)) continue
    stateOrders[state] = order
    baselineOrders[state] = live
  }
  return {
    edits,
    dropped,
    warnings,
    stateOrders,
    baselineOrders,
    plateIds: trackedPlateIds(batch.plateIds, kept),
  }
}

/**
 * Settle the draft after a release publishes: move it onto the new version, record the
 * publish and prune the change log the release made redundant. Safe to repeat.
 */
export async function afterPublish(
  d: ReviewDeps,
  releaseBatchId: string,
  version: number
): Promise<RebaseOutcome> {
  const release = await d.store.readBatch(releaseBatchId)
  if (!release || !isRelease(release.batch) || !release.batch.source)
    return { ok: false, error: 'not_found' }
  return rebaseDraft(d, release.batch.source.batchId, version, {
    ...release,
    version,
    at: d.now(),
  })
}
