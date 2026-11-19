import type { Plate } from '../../catalog/types'
import { canEdit } from '../../review/access'
import {
  batchPlateLimit,
  editableKeys,
  parseEditableFields,
} from '../../review/fields'
import { validGroupContext } from '../../review/group-context'
import { pipelineImageFields } from '../../review/pipeline-changes'
import { plateRevision } from '../../review/revision'
import { sameEditableValue } from '../../review/story'
import type { ProposedEdit } from '../../review/types'
import { queueGroupContext, queueRecordFits } from './queue'
import type { RunProjection } from './queue-projection'
import type { PipelineRun } from './queue-types'
import type { ImageCandidate } from '../specialized-suggestions'
import type { JobsDeps, JobsTransaction, TaggingJob } from '../types'

type DraftResult =
  | { projection: RunProjection; conflict: boolean; changedPlateIds: string[] }
  | {
      error:
        | 'batch_read_only'
        | 'stale_input'
        | 'invalid_result'
        | 'invalid_group_scope'
        | 'draft_conflict'
        | 'payload_too_large'
    }

/**
 * Save a stage result to the open batch when the requester and input still qualify, then
 * refresh the run projection.
 */
export async function saveQueueDraft(
  d: JobsDeps,
  tx: JobsTransaction,
  run: PipelineRun,
  job: TaggingJob,
  before: RunProjection,
  after: RunProjection,
  candidate?: ImageCandidate
): Promise<DraftResult> {
  const batch = await tx.batch(run.batchId)
  const role = d.configuredOwnerUids?.includes(run.requestedBy)
    ? 'owner'
    : tx.pipelineRequesterRole
      ? await tx.pipelineRequesterRole(run.requestedBy)
      : run.requestedByRole
  const byName = run.requestedByName ?? null
  if (
    !batch ||
    batch.state !== 'open' ||
    !role ||
    !canEdit(batch, { uid: run.requestedBy, role, name: byName })
  )
    return { error: 'batch_read_only' }
  if (batch.baselineVersion !== before.baselineVersion)
    return { error: 'stale_input' }

  const suggestion = job.result?.fieldSuggestion
  const targets =
    suggestion?.kind === 'group' ? Object.keys(before.plates) : [job.plateId]
  const projection = { ...after, plates: { ...after.plates } }
  const current = new Map<string, Plate>()
  const edits: ProposedEdit[] = []
  const plateIds = new Set(batch.plateIds)
  const at = new Date(d.now()).toISOString()
  let conflict = false

  for (const id of targets) {
    const oldProjection = before.plates[id]
    const newProjection = after.plates[id]
    const draft = await tx.review(batch.id, id)
    const baseline = d.baselineAtVersion
      ? await d.baselineAtVersion(batch.baselineVersion, id)
      : await d.baseline(id)
    if (!baseline || !draft || !oldProjection || !newProjection)
      return { error: 'stale_input' }
    const actual = { ...baseline, ...draft.fields }
    current.set(id, actual)
    if (
      suggestion?.kind === 'group' &&
      plateRevision(actual) !== oldProjection.batchInputHash
    )
      return { error: 'draft_conflict' }

    const expected = oldProjection.executionPlate
    const incoming = newProjection.executionPlate
    const fields = editableKeys.filter(
      (key) => !sameEditableValue(key, expected[key], incoming[key])
    )
    const conflicts = new Set(
      fields.filter(
        (key) =>
          !sameEditableValue(key, actual[key], expected[key]) &&
          !sameEditableValue(key, actual[key], incoming[key])
      )
    )
    if (
      candidate &&
      pipelineImageFields.some(
        (key) =>
          !sameEditableValue(key, actual[key], expected[key]) &&
          !sameEditableValue(key, actual[key], incoming[key])
      )
    ) {
      conflicts.add('imageUrl')
      conflicts.add('sourceUrl')
    }
    conflict ||= conflicts.size > 0
    const changed = fields.filter(
      (key) =>
        !conflicts.has(key) &&
        !sameEditableValue(key, actual[key], incoming[key])
    )
    let next = actual
    if (changed.length) {
      const input: Record<string, unknown> = Object.fromEntries(
        changed.map((key) => [key, incoming[key]])
      )
      if (candidate)
        Object.assign(input, {
          imageUrl: candidate.imageUrl,
          sourceUrl: candidate.sourceUrl,
        })
      const parsed = parseEditableFields(input, candidate)
      if (!parsed) return { error: 'invalid_result' }
      next = { ...actual, ...parsed }
      const delta = Object.fromEntries(
        editableKeys
          .filter((key) => !sameEditableValue(key, baseline[key], next[key]))
          .map((key) => [key, next[key]])
      )
      const pipelineChanges = { ...draft.edit?.pipelineChanges }
      const attributedFields = candidate ? pipelineImageFields : changed
      for (const key of attributedFields) {
        const existing = pipelineChanges[key]
        let prior = existing?.prior ?? []
        let previous = actual[key]
        if (existing && sameEditableValue(key, existing.value, actual[key])) {
          if (existing.runId === run.id) previous = existing.previous
          else {
            const { prior: history = [], ...entry } = existing
            prior = [...history, entry]
          }
        } else prior = []
        const value = next[key]
        pipelineChanges[key] = {
          runId: run.id,
          jobId: job.id,
          by: run.requestedBy,
          byName,
          at,
          ...(previous === undefined ? {} : { previous }),
          ...(value === undefined ? {} : { value }),
          ...(prior.length ? { prior } : {}),
        }
      }
      plateIds.add(id)
      edits.push({
        plateId: id,
        baseRevision: plateRevision(baseline),
        fields: delta,
        authorId: run.requestedBy,
        authorName: byName,
        updatedAt: at,
        resultRevision: plateRevision(next),
        pipelineChanges,
        pipelineRunIds: [
          ...new Set([
            ...(draft.edit?.pipelineRunIds ?? []),
            run.id,
            ...(run.selectionId ? [run.selectionId] : []),
          ]),
        ],
      })
    }

    // The next stage sees the effective draft, including unrelated human edits.
    const hash = plateRevision(next)
    projection.plates[id] = {
      ...newProjection,
      batchInput: next,
      batchInputHash: hash,
      executionPlate: next,
      executionHash: hash,
    }
  }
  if (suggestion?.kind === 'group') {
    const selected = [...current.values()]
    const context = await queueGroupContext(d, tx, batch, selected)
    if (
      !context ||
      job.standardId !== context.standardId ||
      !validGroupContext(
        suggestion,
        selected,
        context.statePlates,
        context.standardId
      )
    )
      return { error: 'invalid_group_scope' }
  }
  const attempt = run.attempts.at(-1)!
  const changedPlateIds = edits.map((edit) => edit.plateId)
  const draftPlateIds = [
    ...new Set([...(run.draftPlateIds ?? []), ...changedPlateIds]),
  ]
  const fits = queueRecordFits({
    ...run,
    draftPlateIds,
    attempts: [...run.attempts.slice(0, -1), { ...attempt, projection }],
  })
  if (!fits) return { error: 'payload_too_large' }
  if (plateIds.size > batchPlateLimit(batch)) return { error: 'invalid_result' }
  if (edits.length) {
    const result = await tx.commitDraft(batch.id, batch.revision, {
      batch: {
        ...batch,
        lastChangedAt: at,
        revision: batch.revision + 1,
        approval: null,
        plateIds: [...plateIds],
      },
      by: { uid: run.requestedBy, name: byName },
      edits,
    })
    if (result !== 'ok') return { error: 'draft_conflict' }
  }
  return { projection, conflict, changedPlateIds }
}
