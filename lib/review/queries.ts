import type { Plate } from '../catalog/types'
import { plateRevision } from './revision'
import type { Actor, BatchState, Outcome, ProposedEdit, ReviewBatch, ReviewDeps } from './types'

type BatchDetail = {
  batch: ReviewBatch
  plates: { baseline: Plate; proposed: Plate; edit: ProposedEdit | null; revision: string }[]
}

export async function createBatch(
  d: ReviewDeps,
  actor: Actor,
  i: { id: string; name: string; plateIds: string[]; baselineVersion: number },
): Promise<Outcome<ReviewBatch>> {
  if (i.plateIds.length === 0 || i.name.trim().length === 0 || new Set(i.plateIds).size !== i.plateIds.length) {
    return { ok: false, error: 'invalid_state' }
  }
  const batch: ReviewBatch = {
    ...i, plateIds: [...i.plateIds], state: 'open', revision: 0, approval: null,
    createdBy: actor.uid, createdByName: actor.name, createdAt: d.now(),
  }
  const result = await d.store.create(batch)
  return result === 'ok' ? { ok: true, value: batch } : { ok: false, error: 'invalid_state' }
}

export async function listBatches(d: ReviewDeps, filter: { states?: BatchState[]; createdBy?: string }): Promise<ReviewBatch[]> {
  return (await d.store.list(filter)).filter(batch => filter.createdBy === undefined || batch.createdBy === filter.createdBy).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export async function batchDetail(d: ReviewDeps, batchId: string): Promise<Outcome<BatchDetail>> {
  const batch = await d.store.getBatch(batchId)
  if (!batch) return { ok: false, error: 'not_found' }
  const edits = new Map((await d.store.listEdits(batchId)).map(edit => [edit.plateId, edit]))
  const plates: BatchDetail['plates'] = []
  for (const plateId of batch.plateIds) {
    const baseline = await d.baseline(plateId)
    if (!baseline) return { ok: false, error: 'not_found' }
    const edit = edits.get(plateId) ?? null
    const proposed = { ...baseline, ...edit?.fields }
    plates.push({ baseline, proposed, edit, revision: plateRevision(proposed) })
  }
  return { ok: true, value: { batch, plates } }
}
