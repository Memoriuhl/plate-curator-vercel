import type { Plate } from '../catalog/types'
import { plateRevision } from './revision'
import type { Actor, BatchState, Outcome, ProposedEdit, ReviewBatch, ReviewDeps } from './types'

type BatchDetail = {
  batch: ReviewBatch
  plates: { baseline: Plate; proposed: Plate; edit: ProposedEdit | null; revision: string; order?: { before: number; after: number; total: number } }[]
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
    ...i, stateOrders: {}, plateIds: [...i.plateIds], state: 'open', revision: 0, approval: null,
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
  const orders = new Map<string, { before: number; after: number; total: number }>()
  const ids = new Set(batch.plateIds)
  for (const [state, order] of Object.entries(batch.stateOrders)) {
    const baseline = batch.baselineOrders?.[state] ?? (await d.stateBaseline(batch.baselineVersion, state, batch.state === 'published' ? 'snapshot' : undefined)).map(plate => plate.id)
    const positions = new Map(order.map((id, index) => [id, index]))
    baseline.forEach((plateId, before) => {
      const after = positions.get(plateId)
      if (after === undefined) return
      orders.set(plateId, { before, after, total: baseline.length })
      if (before !== after) ids.add(plateId)
    })
  }
  for (const plateId of ids) {
    const order = orders.get(plateId)
    const baseline = await d.baselineAtVersion(batch.baselineVersion, plateId)
    if (!baseline) return { ok: false, error: 'not_found' }
    const edit = edits.get(plateId) ?? null
    const proposed = { ...baseline, ...edit?.fields }
    plates.push({ baseline, proposed, edit, revision: plateRevision(proposed),
      ...(order ? { order: { before: order.before, after: order.after, total: order.total } } : {}),
    })
  }
  return { ok: true, value: { batch, plates } }
}
