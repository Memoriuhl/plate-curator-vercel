import { draftCommitAttempts, draftRetryPause } from './retry'
import type { Plate } from '../catalog/types'
import { editableKeys } from './fields'
import { plateRevision } from './revision'
import { sameEditableValue } from './story'
import type {
  EditableFields,
  Outcome,
  PlateFieldConflicts,
  ProposedEdit,
  ReviewBatch,
  ReviewDeps,
} from './types'

/** What an operation reads and writes, for its concurrency precondition. */
export type DraftTouch = {
  plateIds?: Iterable<string>
  orderStates?: Iterable<string>
}

/** Returned by one attempt when the draft moved under it and it should re-read. */
export const retryDraft = Symbol('retryDraft')

/**
 * Check that nothing an operation touches changed after the draft revision the curator
 * saw. On the shared draft a newer revision only blocks the operation when a later
 * commit wrote one of its plates or reordered one of its states, so curators working on
 * different plates or states never block each other. Batches made before the shared
 * draft keep the old exact-revision rule.
 */
export async function unchangedSince(
  d: ReviewDeps,
  batch: ReviewBatch,
  seen: number,
  touch: DraftTouch
): Promise<boolean> {
  if (seen === batch.revision) return true
  if (
    batch.kind !== 'shared-draft' ||
    seen > batch.revision ||
    seen < (batch.rebaseFloor ?? 0) ||
    !d.store.listChanges
  )
    return false
  const plates = new Set(touch.plateIds ?? [])
  const states = new Set(touch.orderStates ?? [])
  const changes = await d.store.listChanges(batch.id, seen)
  return !changes.some(
    (change) =>
      change.revision <= batch.revision &&
      (change.plateIds.some((id) => plates.has(id)) ||
        (change.orderStates ?? []).some((state) => states.has(state)))
  )
}

/**
 * Run a read-check-commit attempt until it commits, fails on its own precondition, or
 * runs out of attempts. Each attempt re-reads the draft, so a retry sees the other
 * writer's commit and re-applies the operation on top of it.
 */
export async function retryDraftRace<T>(
  attempt: () => Promise<Outcome<T> | typeof retryDraft>
): Promise<Outcome<T>> {
  for (let index = 0; index < draftCommitAttempts; index += 1) {
    await draftRetryPause(index)
    const result = await attempt()
    if (result !== retryDraft) return result
  }
  return { ok: false, error: 'superseded_revision' }
}

/** Identify the latest write to each requested field by walking this plate's before-images. */
export async function plateFieldConflicts(
  d: ReviewDeps,
  batch: ReviewBatch,
  baseline: Plate,
  existing: ProposedEdit | null,
  seen: string,
  fields: EditableFields
): Promise<PlateFieldConflicts | undefined> {
  const relevant = editableKeys.filter((field) => Object.hasOwn(fields, field))
  const current = { ...baseline, ...existing?.fields }
  const changes =
    batch.kind === 'shared-draft' && d.store.listChanges
      ? await d.store.listChanges(batch.id, batch.rebaseFloor ?? 0)
      : []
  const conflicts: PlateFieldConflicts = {}
  let after = existing
  for (const change of changes.toReversed()) {
    if (
      change.revision > batch.revision ||
      !change.before ||
      !Object.hasOwn(change.before.edits, baseline.id)
    )
      continue
    const before = change.before.edits[baseline.id]
    const old = { ...baseline, ...before?.fields }
    const updated = { ...baseline, ...after?.fields }
    for (const field of relevant) {
      if (
        conflicts[field] ||
        sameEditableValue(field, old[field], updated[field])
      )
        continue
      const pipeline = after?.pipelineChanges?.[field]
      const author = change.contributors[0]
      const attribution =
        pipeline && sameEditableValue(field, pipeline.value, updated[field])
          ? pipeline
          : after
            ? {
                by: after.authorId,
                byName: after.authorName ?? null,
                at: after.updatedAt,
              }
            : author &&
              change.at && {
                by: author.uid,
                byName: author.name,
                at: change.at,
              }
      if (attribution) {
        const { by, byName, at } = attribution
        conflicts[field] = { by, byName, at, value: current[field] ?? null }
      }
    }
    if (plateRevision(old) === seen)
      return Object.keys(conflicts).length ? conflicts : undefined
    after = before
  }

  // Before-images are pruned after Publish and were absent in legacy Batches.
  // If the screen showed the current baseline, remaining draft fields still differ.
  if (plateRevision(baseline) !== seen) return undefined
  for (const field of relevant) {
    if (sameEditableValue(field, baseline[field], current[field]))
      delete conflicts[field]
    else if (!conflicts[field] && existing) {
      const pipeline = existing.pipelineChanges?.[field]
      conflicts[field] = {
        by: pipeline?.by ?? existing.authorId,
        byName: pipeline ? pipeline.byName : (existing.authorName ?? null),
        at: pipeline?.at ?? existing.updatedAt,
        value: current[field] ?? null,
      }
    }
  }
  return Object.keys(conflicts).length ? conflicts : undefined
}
