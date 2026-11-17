import type { Plate } from '../catalog/types'
import { canEdit } from '../review/access'
import { editableFieldKeys, editableKeys, limits, parseEditableFields } from '../review/fields'
import { plateRevision } from '../review/revision'
import { sameEditableValue } from '../review/story'
import type { Actor, Outcome, ProposedEdit, ReviewBatch, ReviewDeps } from '../review/types'
import { localQueueEnabled } from './queue'
import type { JobsDeps } from './types'

export async function applyQueueBundle(jobs: JobsDeps, review: ReviewDeps, actor: Actor, id: string): Promise<Outcome<ReviewBatch>> {
  if (!localQueueEnabled(jobs)) return { ok: false, error: 'forbidden' }
  const run = await jobs.store.transaction(async tx => (await tx.runs()).find(run => run.id === id && run.localScope === jobs.localScope))
  if (!run) return { ok: false, error: 'not_found' }
  const snapshot = await review.store.readBatch(run.batchId)
  if (!snapshot) return { ok: false, error: 'not_found' }
  const { batch, edits } = snapshot
  if (!canEdit(batch, actor)) return { ok: false, error: 'forbidden' }
  if (batch.state !== 'open') return { ok: false, error: 'invalid_state' }
  const attempt = run.attempts.at(-1)!
  const token = `${run.id}:${attempt.number}`
  if (batch.pipelineApplications?.[token]) return { ok: true, value: batch }
  if (run.status !== 'completed' || !attempt.projection || Object.keys(batch.pipelineApplications ?? {}).length >= 50 ||
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
  const changes = new Map<string, Partial<Plate>>()
  for (const entry of Object.values(attempt.projection.plates)) {
    const before = current.get(entry.batchInput.id)!
    const fields: Record<string, unknown> = Object.fromEntries(editableFieldKeys().filter(key => !sameEditableValue(key, before[key], entry.executionPlate[key]))
      .map(key => [key, entry.executionPlate[key]]))
    if (!Object.keys(fields).length) continue
    if (Object.hasOwn(fields, 'sourceUrl') || Object.hasOwn(fields, 'imageUrl')) {
      fields.imageUrl = entry.executionPlate.imageUrl; fields.sourceUrl = entry.executionPlate.sourceUrl
    }
    if (!parseEditableFields(fields)) return { ok: false, error: 'invalid_state' }
    changes.set(before.id, fields)
  }
  if (run.stages.includes('group')) {
    const selected = [...current.values()]
    if (!selected.length || new Set(selected.map(plate => plate.state)).size !== 1) return { ok: false, error: 'invalid_state' }
    const state = selected[0].state
    const statePlates = (await review.stateBaseline(batch.baselineVersion, state)).map(plate => ({ ...plate, ...edits.find(edit => edit.plateId === plate.id)?.fields }))
    const ids = new Set(selected.map(plate => plate.id))
    const families = new Set(selected.map(plate => plate.templateFamily).filter(Boolean))
    if (statePlates.some(plate => !plate.deleted && !ids.has(plate.id) && (families.has(plate.templateFamily) || ids.has(plate.variantOfPlateId ?? ''))) ||
      selected.some(plate => plate.deleted || plate.variantOfPlateId && !ids.has(plate.variantOfPlateId))) return { ok: false, error: 'invalid_state' }
    const standardId = batch.stateOrders[state]?.[0] ?? statePlates.find(plate => plate.isStandard)?.id ?? statePlates[0]?.id
    const proposed = selected.map(plate => ({ ...plate, ...changes.get(plate.id) }))
    if (proposed.some(plate => plate.id === standardId && plate.templateRole !== 'template')) return { ok: false, error: 'invalid_state' }
    const templates = proposed.filter(plate => plate.templateRole === 'template')
    if (templates.some(plate => plate.templateFamily !== plate.id) || statePlates.some(plate => !plate.deleted && !ids.has(plate.id) &&
      templates.some(template => template.templateFamily === plate.templateFamily))) return { ok: false, error: 'invalid_state' }
    if (proposed.some(plate => plate.templateRole === 'variant' && !templates.some(template => template.id === plate.variantOfPlateId && template.templateFamily === plate.templateFamily))) return { ok: false, error: 'invalid_state' }
  }
  const nextEdits: ProposedEdit[] = []
  const deleteEditsFor: string[] = []
  const plateIds = new Set(batch.plateIds)
  for (const [plateId, fields] of changes) {
    const baseline = baselines.get(plateId)!
    const plate = { ...current.get(plateId)!, ...fields }
    const delta = Object.fromEntries(editableKeys.filter(key => !sameEditableValue(key, baseline[key], plate[key])).map(key => [key, plate[key]]))
    if (!Object.keys(delta).length) deleteEditsFor.push(plateId)
    else {
      plateIds.add(plateId)
      nextEdits.push({ plateId, baseRevision: plateRevision(baseline), fields: delta, authorId: actor.uid, updatedAt: review.now(), resultRevision: plateRevision(plate) })
    }
  }
  if (plateIds.size > limits.plates) return { ok: false, error: 'invalid_state' }
  const next: ReviewBatch = { ...batch, revision: batch.revision + 1, approval: null, plateIds: [...plateIds],
    pipelineApplications: { ...batch.pipelineApplications, [token]: { by: actor.uid, at: review.now() } } }
  const result = await review.store.commit(batch.id, batch.revision, { batch: next, edits: nextEdits, deleteEditsFor })
  if (result !== 'ok') {
    const latest = await review.store.getBatch(batch.id)
    if (latest?.pipelineApplications?.[token]) return { ok: true, value: latest }
  }
  return result === 'ok' ? { ok: true, value: next } : { ok: false, error: 'superseded_revision' }
}
