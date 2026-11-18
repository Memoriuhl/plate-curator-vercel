import { orderDifferences } from './order-diff'
import type { Actor, ProposedEdit, ReviewBatch } from './types'

export type ReviewCheckpoint = { revision: number; viewedAt: string }
export type ReviewChanges = { revision: number; since: number | null; plateCount: number; contributors: string[] }
type Author = Pick<Actor, 'uid' | 'name'>
export type DraftChange = { revision: number; plateIds: string[]; contributors: Author[] }

export function draftChange(
  previous: ReviewBatch,
  next: ReviewBatch,
  edits: ProposedEdit[],
  deleted: string[],
  actor?: Author,
) {
  const plateIds = new Set([...edits.map(edit => edit.plateId), ...deleted])
  for (const [state, order] of Object.entries(next.stateOrders)) {
    const old = previous.stateOrders[state] ?? next.baselineOrders?.[state] ?? []
    const changed = old.length ? orderDifferences(old, order).map(entry => entry.plateId) : order
    if (!changed.length) continue
    for (const id of changed) plateIds.add(id)
  }

  const contributors = new Map(edits.map(edit => [edit.authorId, { uid: edit.authorId, name: edit.authorName ?? null }]))
  if (actor) contributors.set(actor.uid, actor)
  if (plateIds.size === 0) return null
  return { revision: next.revision, plateIds: [...plateIds], contributors: [...contributors.values()].map(({ uid, name }) => ({ uid, name })) }
}

export function reviewChanges(revision: number, viewed: ReviewCheckpoint | null, changes: DraftChange[]): ReviewChanges {
  return {
    revision,
    since: viewed?.revision ?? null,
    plateCount: new Set(changes.flatMap(change => change.plateIds)).size,
    contributors: [...new Set(changes.flatMap(change => change.contributors.map(author => author.name || author.uid)))].sort(),
  }
}

export function currentDraftChanges(batch: ReviewBatch, editIds: string[], changes: DraftChange[]): DraftChange[] {
  const netIds = new Set(editIds)
  for (const [state, order] of Object.entries(batch.stateOrders ?? {})) {
    const before = batch.baselineOrders?.[state]
    const reordered = before ? orderDifferences(before, order).map(entry => entry.plateId) : order
    for (const id of reordered) netIds.add(id)
  }
  return changes.flatMap(change => {
    const plateIds = change.plateIds.filter(id => netIds.has(id))
    return plateIds.length ? [{ ...change, plateIds }] : []
  })
}
