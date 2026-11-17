import type { Plate } from '../catalog/types'
import { getJobForActor } from '../jobs/jobs'
import type { JobsDeps } from '../jobs/types'
import { parseGroupSuggestion } from '../jobs/specialized-suggestions'
import { completeGroupScope, validGroupContext } from './group-context'
export { completeGroupScope, validGroupContext } from './group-context'
import { canEdit } from './access'
import { editableKeys, limits } from './fields'
import { plateRevision } from './revision'
import { sameEditableValue } from './story'
import type { Actor, Outcome, ProposedEdit, ReviewBatch, ReviewDeps } from './types'

export async function prepareGroupScope(d: ReviewDeps, actor: Actor, input: { batchId: string; batchRevision: number; plateIds: string[] }): Promise<Outcome<{ scope: import('../jobs/specialized-suggestions').GroupInput; standardId?: string }>> {
  const snapshot = await d.store.readBatch(input.batchId)
  if (!snapshot) return { ok: false, error: 'not_found' }
  const { batch, edits } = snapshot
  if (!canEdit(batch, actor)) return { ok: false, error: 'forbidden' }
  if (batch.state !== 'open') return { ok: false, error: 'invalid_state' }
  if (batch.revision !== input.batchRevision) return { ok: false, error: 'superseded_revision' }
  if (input.plateIds.some(id => !batch.plateIds.includes(id))) return { ok: false, error: 'invalid_state' }
  if (!input.plateIds.length || input.plateIds.length > 25 || new Set(input.plateIds).size !== input.plateIds.length) return { ok: false, error: 'invalid_state' }
  const scope = []
  for (const id of input.plateIds) {
    const baseline = await d.baselineAtVersion(batch.baselineVersion, id)
    if (!baseline) return { ok: false, error: 'not_found' }
    const plate = { ...baseline, ...edits.find(edit => edit.plateId === id)?.fields }
    scope.push({ plate, baseRevision: plateRevision(plate) })
  }
  const statePlates = (await d.stateBaseline(batch.baselineVersion, scope[0].plate.state)).map(plate => ({ ...plate, ...edits.find(edit => edit.plateId === plate.id)?.fields }))
  if (!completeGroupScope(scope.map(member => member.plate), statePlates)) return { ok: false, error: 'invalid_state' }
  return { ok: true, value: { scope, standardId: batch.stateOrders[scope[0].plate.state]?.[0] ?? statePlates.find(plate => plate.isStandard)?.id ?? statePlates[0]?.id } }
}

export async function acceptGroup(d: ReviewDeps, jobs: JobsDeps, actor: Actor, input: { batchId: string; batchRevision: number; jobId: string }): Promise<Outcome<ReviewBatch>> {
  if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1') return { ok: false, error: 'forbidden' }
  const found = await getJobForActor(jobs, actor, input.jobId)
  if (!found.ok) return found
  const job = found.value
  if (job.previewOnly || !jobs.localScope || job.localScope !== jobs.localScope || job.batchId !== input.batchId || job.stage !== 'group' || job.state !== 'completed' || 'queueRunId' in job && job.queueRunId) return { ok: false, error: 'invalid_state' }
  const suggestion = parseGroupSuggestion(job.result?.fieldSuggestion)
  const expected = job.groupScope?.map(member => ({ plateId: member.plate.id, baseRevision: member.baseRevision })).sort((a, b) => a.plateId.localeCompare(b.plateId))
  if (!suggestion || JSON.stringify(suggestion.scope) !== JSON.stringify(expected)) return { ok: false, error: 'invalid_state' }
  const snapshot = await d.store.readBatch(input.batchId)
  if (!snapshot) return { ok: false, error: 'not_found' }
  const { batch, edits } = snapshot
  if (!canEdit(batch, actor)) return { ok: false, error: 'forbidden' }
  if (batch.state !== 'open') return { ok: false, error: 'invalid_state' }
  if (batch.revision !== input.batchRevision) return { ok: false, error: 'superseded_revision' }
  if (suggestion.scope.some(member => !batch.plateIds.includes(member.plateId))) return { ok: false, error: 'invalid_state' }
  const selected: Plate[] = []
  const baselines = new Map<string, Plate>()
  for (const member of suggestion.scope) {
    const baseline = await d.baselineAtVersion(batch.baselineVersion, member.plateId)
    if (!baseline) return { ok: false, error: 'not_found' }
    baselines.set(member.plateId, baseline)
    const plate = { ...baseline, ...edits.find(edit => edit.plateId === member.plateId)?.fields }
    if (plateRevision(plate) !== member.baseRevision) return { ok: false, error: 'stale_plate', current: plate }
    selected.push(plate)
  }
  const state = selected[0].state
  const statePlates = (await d.stateBaseline(batch.baselineVersion, state)).map(plate => ({ ...plate, ...edits.find(edit => edit.plateId === plate.id)?.fields }))
  const standardId = batch.stateOrders[state]?.[0] ?? statePlates.find(plate => plate.isStandard)?.id ?? statePlates[0]?.id
  if (!validGroupContext(suggestion, selected, statePlates, standardId)) return { ok: false, error: 'invalid_state' }
  const ids = new Set(selected.map(plate => plate.id))
  const plateIds = [...new Set([...batch.plateIds, ...ids])]
  if (plateIds.length > limits.plates) return { ok: false, error: 'invalid_state' }
  const nextEdits: ProposedEdit[] = []
  const deleteEditsFor: string[] = []
  for (const proposal of suggestion.proposals) {
    const baseline = baselines.get(proposal.plateId)!
    const current = selected.find(plate => plate.id === proposal.plateId)!
    const plate: Plate = { ...current, ...proposal.fields }
    const fields = Object.fromEntries(editableKeys.filter(key => !sameEditableValue(key, baseline[key], plate[key])).map(key => [key, plate[key]]))
    if (!Object.keys(fields).length) deleteEditsFor.push(plate.id)
    else nextEdits.push({ plateId: plate.id, baseRevision: plateRevision(baseline), fields, authorId: actor.uid, updatedAt: d.now(), resultRevision: plateRevision(plate) })
  }
  const next: ReviewBatch = { ...batch, plateIds, revision: batch.revision + 1, approval: null }
  const committed = await d.store.commit(batch.id, batch.revision, { batch: next, edits: nextEdits, deleteEditsFor })
  return committed === 'ok' ? { ok: true, value: next } : { ok: false, error: 'superseded_revision' }
}
