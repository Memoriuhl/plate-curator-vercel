import type { Plate } from '../catalog/types'
import { canEdit } from '../review/access'
import { editableFieldKeys, editableKeys, limits, parseEditableFields } from '../review/fields'
import { retainedPipelineChanges } from '../review/pipeline-changes'
import { plateRevision } from '../review/revision'
import { sameEditableValue } from '../review/story'
import type { Actor, EditableFields, Outcome, ProposedEdit, ReviewBatch, ReviewDeps } from '../review/types'
import { localQueueEnabled } from './queue'
import type { JobsDeps } from './types'
import { verifiedImageFields } from '../review/image'
import { validGroupContext } from '../review/group-context'
import { parseFieldSuggestion } from './suggestions'
import type { ImageCandidate } from './specialized-suggestions'

export async function applyQueueBundle(jobs: JobsDeps, review: ReviewDeps, actor: Actor, id: string, readImage?: Parameters<typeof verifiedImageFields>[1]): Promise<Outcome<ReviewBatch>> {
  if (!localQueueEnabled(jobs)) return { ok: false, error: 'forbidden' }
  const run = await jobs.store.transaction(async tx => (await tx.runs()).find(run => run.id === id && run.localScope === jobs.localScope))
  if (!run) return { ok: false, error: 'not_found' }
  if (run.previewOnly) return { ok: false, error: 'forbidden' }
  const snapshot = await review.store.readBatch(run.batchId)
  if (!snapshot) return { ok: false, error: 'not_found' }
  const { batch, edits } = snapshot
  if (!canEdit(batch, actor)) return { ok: false, error: 'forbidden' }
  if (batch.state !== 'open') return { ok: false, error: 'invalid_state' }
  const attempt = run.attempts.at(-1)!
  if (run.incrementalDrafts) return ['completed', 'failed', 'cancelled'].includes(run.status)
    ? { ok: true, value: batch } : { ok: false, error: 'invalid_state' }
  const token = `${run.id}:${attempt.number}`
  if (batch.pipelineApplications?.[token]) return { ok: true, value: batch }
  if (run.status !== 'completed' || attempt.outcome === 'no_result' || !attempt.projection || Object.keys(batch.pipelineApplications ?? {}).length >= 50 ||
    attempt.projection.baselineVersion !== batch.baselineVersion || attempt.cursor !== attempt.steps.length) return { ok: false, error: 'invalid_state' }
  const baselines = new Map<string, Plate>()
  const current = new Map<string, Plate>()
  for (const entry of Object.values(attempt.projection.plates)) {
    const baseline = await review.baselineAtVersion(batch.baselineVersion, entry.batchInput.id)
    if (!baseline) return { ok: false, error: 'not_found' }
    const actual = { ...baseline, ...edits.find(edit => edit.plateId === baseline.id)?.fields }
    if (plateRevision(actual) !== entry.batchInputHash) return { ok: false, error: 'stale_plate', current: actual }
    baselines.set(baseline.id, baseline); current.set(baseline.id, actual)
  }
  const changes = new Map<string, EditableFields>()
  const storedJobs = await jobs.store.transaction(async tx => {
    const result = []
    for (const id of attempt.completedJobIds) {
      const job = await tx.get(id)
      if (job?.queueRunId === run.id && job.localScope === jobs.localScope && job.batchId === batch.id && job.state === 'completed') result.push(job)
    }
    return result
  })
  if (storedJobs.length !== attempt.completedJobIds.length) return { ok: false, error: 'invalid_state' }
  for (const entry of Object.values(attempt.projection.plates)) {
    const before = current.get(entry.batchInput.id)!
    const fields: Record<string, unknown> = Object.fromEntries(editableFieldKeys().filter(key => !sameEditableValue(key, before[key], entry.executionPlate[key]))
      .map(key => [key, entry.executionPlate[key]]))
    if (!Object.keys(fields).length) continue
    let candidate: ImageCandidate | undefined
    if (Object.hasOwn(fields, 'sourceUrl') || Object.hasOwn(fields, 'imageUrl')) {
      fields.imageUrl = entry.executionPlate.imageUrl; fields.sourceUrl = entry.executionPlate.sourceUrl
      const imageJob = storedJobs.findLast(job => job.plateId === before.id && job.stage === 'find-image' && entry.sourceJobIds.includes(job.id))
      const suggestion = parseFieldSuggestion(imageJob?.result?.fieldSuggestion, 'find-image')
      candidate = suggestion?.kind === 'image' ? suggestion.candidates.find(value => value.id === attempt.choices[imageJob!.id]) : undefined
      if (!candidate || candidate.imageUrl !== fields.imageUrl || candidate.sourceUrl !== fields.sourceUrl || !await verifiedImageFields(candidate, readImage)) return { ok: false, error: 'invalid_state' }
    }
    const parsed = parseEditableFields(fields, candidate)
    if (!parsed) return { ok: false, error: 'invalid_state' }
    changes.set(before.id, parsed)
  }
  if (run.stages.includes('group')) {
    const selected = [...current.values()]
    if (!selected.length || new Set(selected.map(plate => plate.state)).size !== 1) return { ok: false, error: 'invalid_state' }
    const state = selected[0].state
    const statePlates = (await review.stateBaseline(batch.baselineVersion, state, 'snapshot')).map(plate => ({ ...plate, ...edits.find(edit => edit.plateId === plate.id)?.fields }))
    const standardId = batch.stateOrders[state]?.[0] ?? statePlates[0]?.id
    const groupJob = storedJobs.findLast(job => job.stage === 'group')
    const suggestion = parseFieldSuggestion(groupJob?.result?.fieldSuggestion, 'group')
    if (selected.some(plate => !batch.plateIds.includes(plate.id)) || !groupJob || groupJob.standardId !== standardId || suggestion?.kind !== 'group' ||
      suggestion.scope.some(member => attempt.projection!.plates[member.plateId]?.batchInputHash !== member.baseRevision) ||
      !validGroupContext(suggestion, selected, statePlates, standardId) || suggestion.proposals.some(proposal => {
        const projected = attempt.projection!.plates[proposal.plateId]?.executionPlate
        return !projected || Object.entries(proposal.fields).some(([key, value]) => projected[key as keyof Plate] !== value)
      })) return { ok: false, error: 'invalid_state' }
  }
  const nextEdits: ProposedEdit[] = []
  const deleteEditsFor: string[] = []
  const plateIds = new Set(batch.plateIds)
  const byId = new Map(edits.map(edit => [edit.plateId, edit]))
  const at = review.now()
  for (const [plateId, fields] of changes) {
    const baseline = baselines.get(plateId)!
    const before = current.get(plateId)!
    const plate = { ...before, ...fields }
    const delta = Object.fromEntries(editableKeys.filter(key => !sameEditableValue(key, baseline[key], plate[key])).map(key => [key, plate[key]]))
    if (!Object.keys(delta).length) deleteEditsFor.push(plateId)
    else {
      plateIds.add(plateId)
      const previous = retainedPipelineChanges(byId.get(plateId), delta, plate)
      const pipelineChanges = { ...previous.pipelineChanges }
      const jobId = attempt.projection.plates[plateId]?.sourceJobIds.at(-1) ?? token
      for (const key of editableKeys) {
        if (!Object.hasOwn(delta, key) || sameEditableValue(key, before[key], plate[key])) continue
        const value = fields[key]
        const prior = key === 'imageUrl'
          ? typeof before.imageUrl === 'string' || before.imageUrl === null ? before.imageUrl : undefined
          : before[key]
        pipelineChanges[key] = {
          runId: run.id, jobId, by: run.requestedBy, byName: actor.uid === run.requestedBy ? actor.name : null, at,
          ...(prior !== undefined ? { previous: prior } : {}),
          ...(value !== undefined ? { value } : {}),
        }
      }
      nextEdits.push({ plateId, baseRevision: plateRevision(baseline), fields: delta, authorId: actor.uid, updatedAt: at, resultRevision: plateRevision(plate),
        pipelineChanges, pipelineRunIds: [...new Set([...(previous.pipelineRunIds ?? []), run.id])] })
    }
  }
  if (plateIds.size > limits.plates) return { ok: false, error: 'invalid_state' }
  const next: ReviewBatch = { ...batch, revision: batch.revision + 1, approval: null, plateIds: [...plateIds],
    pipelineApplications: { ...batch.pipelineApplications, [token]: { by: actor.uid, at } } }
  const result = await review.store.commit(batch.id, batch.revision, { batch: next, edits: nextEdits, deleteEditsFor })
  if (result !== 'ok') {
    const latest = await review.store.getBatch(batch.id)
    if (latest?.pipelineApplications?.[token]) return { ok: true, value: latest }
  }
  return result === 'ok' ? { ok: true, value: next } : { ok: false, error: 'superseded_revision' }
}
