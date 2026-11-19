import { editableStates } from '../access'
import { clearedValue } from './draft'
import { isSharedDraft } from './draft-id'
import { editableKeys } from '../fields'
import { restoredPipelineChange } from '../pipeline-changes'
import { retryDraftRace } from '../preconditions'
import { commitDraftRevert } from './revert-commit'
import { sameEditableValue } from '../story'
import type {
  Actor,
  EditableFields,
  Outcome,
  ProposedEdit,
  ReviewDeps,
} from '../types'

type Field = keyof EditableFields
export type RunRevertResult = {
  batchId: string
  revision: number
  reverted: number
  skipped: { plateId: string; field: Field }[]
}

/** Record which fields this run changed, including attributions now overwritten. */
function collectRunFields(
  affected: Map<string, Set<Field>>,
  runId: string,
  edit: ProposedEdit | null,
  published?: ProposedEdit
) {
  if (!edit?.pipelineChanges) return
  for (const field of editableKeys) {
    const change = edit.pipelineChanges[field]
    const shipped =
      published && Object.hasOwn(published.fields, field)
        ? published.pipelineChanges?.[field]
        : undefined
    if (
      ![change, ...(change?.prior ?? [])].some(
        (entry) =>
          entry?.runId === runId &&
          !(
            shipped?.runId === runId &&
            shipped.jobId === entry.jobId &&
            shipped.at === entry.at
          ) &&
          !sameEditableValue(field, entry.previous, entry.value)
      )
    )
      continue
    const fields = affected.get(edit.plateId) ?? new Set()
    fields.add(field)
    affected.set(edit.plateId, fields)
  }
}

/** Restore a run's still-current fields in a single draft commit. */
export function revertPipelineRun(
  d: ReviewDeps,
  actor: Actor,
  { batchId, runId }: { batchId: string; runId: string }
): Promise<Outcome<RunRevertResult>> {
  return retryDraftRace(async () => {
    const snapshot = await d.store.readBatch(batchId)
    if (!snapshot || !isSharedDraft(snapshot.batch))
      return { ok: false, error: 'not_found' }
    const { batch, edits } = snapshot
    if (!editableStates.includes(batch.state))
      return { ok: false, error: 'invalid_state' }
    // A rebase raises the reconstruction floor, but newer unpublished writes still
    // have before-images on the other side of that floor.
    const log = await d.store.listChanges?.(
      batch.id,
      batch.lastPublish?.revision ?? 0
    )
    const published = new Map(
      (batch.lastPublish
        ? await d.store.listEdits(batch.lastPublish.releaseId)
        : []
      ).map((edit) => [edit.plateId, edit])
    )
    const affected = new Map<string, Set<Field>>()
    const current = new Map(edits.map((edit) => [edit.plateId, edit]))
    for (const edit of edits)
      collectRunFields(affected, runId, edit, published.get(edit.plateId))
    for (const change of log ?? []) {
      if (change.revision > batch.revision) continue
      for (const edit of Object.values(change.before?.edits ?? {}))
        collectRunFields(
          affected,
          runId,
          edit,
          edit ? published.get(edit.plateId) : undefined
        )
    }

    const skipped: RunRevertResult['skipped'] = []
    let reverted = 0
    const updates = []
    for (const [plateId, keys] of affected) {
      const previous = current.get(plateId)
      const baseline = await d.baselineAtVersion(batch.baselineVersion, plateId)
      const plate = { ...baseline, ...previous?.fields }
      const fields = { ...previous?.fields }
      const restored: Field[] = []
      const pipelineChanges: NonNullable<ProposedEdit['pipelineChanges']> = {}
      for (const field of keys) {
        const attribution = previous?.pipelineChanges?.[field]
        if (
          !baseline ||
          attribution?.runId !== runId ||
          attribution.restored ||
          !sameEditableValue(field, attribution.value, plate[field])
        ) {
          skipped.push({ plateId, field })
          continue
        }
        const value = attribution.previous
        if (sameEditableValue(field, value, baseline[field]))
          delete fields[field]
        else
          Object.assign(fields, {
            [field]: value === undefined ? clearedValue(field) : value,
          })
        const prior = restoredPipelineChange(field, attribution, value, runId)
        if (prior) pipelineChanges[field] = prior
        restored.push(field)
      }
      if (baseline && previous && restored.length) {
        updates.push({ baseline, previous, fields, restored, pipelineChanges })
        reverted += restored.length
      }
    }
    const outcome = await commitDraftRevert(d, actor, snapshot, updates)
    if (typeof outcome === 'symbol' || !outcome.ok) return outcome
    return {
      ok: true,
      value: { batchId, revision: outcome.value.revision, reverted, skipped },
    }
  })
}
