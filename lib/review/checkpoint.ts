import { orderDifferences } from './order-diff'
import type { Actor, ProposedEdit, ReviewBatch } from './types'

export type ReviewCheckpoint = { revision: number; viewedAt: string }
export type ReviewChanges = {
  revision: number
  since: number | null
  plateCount: number
  contributors: string[]
}
type Author = Pick<Actor, 'uid' | 'name'>
/**
 * What one commit replaced, so the draft at an earlier revision can be rebuilt (Publish
 * at the revision the Owner reviewed) and a change can be reverted later. `null` means
 * the value did not exist before the commit.
 */
export type DraftChangeBefore = {
  edits: Record<string, ProposedEdit | null>
  stateOrders: Record<string, string[] | null>
  baselineOrders: Record<string, string[] | null>
}
export type DraftChange = {
  revision: number
  plateIds: string[]
  at?: string
  contributors: Author[]
  /** Jurisdictions this commit touched, through plate edits or state orders. */
  states?: string[]
  /** Jurisdictions whose saved order this commit changed. */
  orderStates?: string[]
  before?: DraftChangeBefore
}

const sameList = (left?: string[] | null, right?: string[] | null) =>
  (left ?? null) === (right ?? null) ||
  (!!left &&
    !!right &&
    left.length === right.length &&
    left.every((id, index) => id === right[index]))

/**
 * Capture the edits and state orders a commit is about to replace. `previousEdits`
 * holds the stored edit (or null) for every plate the commit writes or deletes.
 */
export function changeBefore(
  previous: ReviewBatch,
  next: ReviewBatch,
  previousEdits: ReadonlyMap<string, ProposedEdit | null>
): DraftChangeBefore {
  const before: DraftChangeBefore = {
    edits: Object.fromEntries(previousEdits),
    stateOrders: {},
    baselineOrders: {},
  }
  const states = new Set([
    ...Object.keys(previous.stateOrders ?? {}),
    ...Object.keys(next.stateOrders ?? {}),
  ])
  for (const state of states)
    if (!sameList(previous.stateOrders?.[state], next.stateOrders?.[state]))
      before.stateOrders[state] = previous.stateOrders?.[state] ?? null
  const baselineStates = new Set([
    ...Object.keys(previous.baselineOrders ?? {}),
    ...Object.keys(next.baselineOrders ?? {}),
  ])
  for (const state of baselineStates)
    if (
      !sameList(previous.baselineOrders?.[state], next.baselineOrders?.[state])
    )
      before.baselineOrders[state] = previous.baselineOrders?.[state] ?? null
  return before
}

/** States a change touched through plate edits or state orders. */
function touchedStates(plateIds: Iterable<string>, before?: DraftChangeBefore) {
  return [
    ...new Set([
      ...[...plateIds].map((id) => id.split('.')[0]),
      ...Object.keys(before?.stateOrders ?? {}),
    ]),
  ].sort()
}

/**
 * Describe the plates and contributors changed by one batch revision for the review
 * checkpoint.
 */
export function draftChange(
  previous: ReviewBatch,
  next: ReviewBatch,
  edits: ProposedEdit[],
  deleted: string[],
  actor?: Author,
  before?: DraftChangeBefore
): DraftChange | null {
  const plateIds = new Set([...edits.map((edit) => edit.plateId), ...deleted])
  for (const [state, order] of Object.entries(next.stateOrders)) {
    const old =
      previous.stateOrders[state] ?? next.baselineOrders?.[state] ?? []
    const changed = old.length
      ? orderDifferences(old, order).map((entry) => entry.plateId)
      : order
    if (!changed.length) continue
    for (const id of changed) plateIds.add(id)
  }

  const contributors = new Map(
    edits.map((edit) => [
      edit.authorId,
      { uid: edit.authorId, name: edit.authorName ?? null },
    ])
  )
  if (actor) contributors.set(actor.uid, actor)
  const replaced =
    !!before &&
    (Object.keys(before.edits).length > 0 ||
      Object.keys(before.stateOrders).length > 0 ||
      Object.keys(before.baselineOrders).length > 0)
  if (plateIds.size === 0 && !replaced) return null
  return {
    revision: next.revision,
    plateIds: [...plateIds],
    contributors: [...contributors.values()].map(({ uid, name }) => ({
      uid,
      name,
    })),
    ...(before
      ? {
          ...(next.lastChangedAt && { at: next.lastChangedAt }),
          states: touchedStates(plateIds, before),
          orderStates: Object.keys(before.stateOrders).sort(),
          before,
        }
      : {}),
  }
}

/** Summarize changes and contributor names since the viewer's checkpoint. */
export function reviewChanges(
  revision: number,
  viewed: ReviewCheckpoint | null,
  changes: DraftChange[]
): ReviewChanges {
  return {
    revision,
    since: viewed?.revision ?? null,
    plateCount: new Set(changes.flatMap((change) => change.plateIds)).size,
    contributors: [
      ...new Set(
        changes.flatMap((change) =>
          change.contributors.map((author) => author.name || author.uid)
        )
      ),
    ].sort(),
  }
}

/** Filter revision history to changes that still appear in the current batch draft. */
export function currentDraftChanges(
  batch: ReviewBatch,
  editIds: string[],
  changes: DraftChange[]
): DraftChange[] {
  const netIds = new Set(editIds)
  for (const [state, order] of Object.entries(batch.stateOrders ?? {})) {
    const before = batch.baselineOrders?.[state]
    const reordered = before
      ? orderDifferences(before, order).map((entry) => entry.plateId)
      : order
    for (const id of reordered) netIds.add(id)
  }
  return changes.flatMap((change) => {
    const plateIds = change.plateIds.filter((id) => netIds.has(id))
    return plateIds.length ? [{ ...change, plateIds }] : []
  })
}
