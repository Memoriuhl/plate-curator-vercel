import { orderDifferences } from './order-diff'
import type { Plate } from '../catalog/types'
import { plateRevision } from './revision'
import type {
  Actor,
  BatchState,
  Outcome,
  ProposedEdit,
  ReviewBatch,
  ReviewDeps,
} from './types'

type BatchDetail = {
  batch: ReviewBatch
  nextOffset?: number
  plates: {
    baseline: Plate
    proposed: Plate
    edit: ProposedEdit | null
    revision: string
    order?: { before: number; after: number; total: number }
  }[]
}

/** Create a draft batch from valid baseline plate IDs and the actor's requested title. */
export async function createBatch(
  d: ReviewDeps,
  actor: Actor,
  i: { id: string; name: string; plateIds: string[]; baselineVersion: number }
): Promise<Outcome<ReviewBatch>> {
  if (
    i.plateIds.length === 0 ||
    i.name.trim().length === 0 ||
    new Set(i.plateIds).size !== i.plateIds.length
  ) {
    return { ok: false, error: 'invalid_state' }
  }
  const batch: ReviewBatch = {
    ...i,
    stateOrders: {},
    plateIds: [...i.plateIds],
    state: 'open',
    revision: 0,
    approval: null,
    createdBy: actor.uid,
    createdByName: actor.name,
    createdAt: d.now(),
  }
  const result = await d.store.create(batch)
  return result === 'ok'
    ? { ok: true, value: batch }
    : { ok: false, error: 'invalid_state' }
}

/** List matching batch summaries in descending creation order for the workspace. */
export async function listBatches(
  d: ReviewDeps,
  filter: { states?: BatchState[]; createdBy?: string }
): Promise<ReviewBatch[]> {
  return (await d.store.list(filter))
    .filter(
      (batch) =>
        filter.createdBy === undefined || batch.createdBy === filter.createdBy
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

/**
 * Read the shared draft's saved orders and edits for the Dashboard's jurisdictions. Every
 * curator's work is in the one draft, so the overlay no longer depends on who is signed
 * in.
 */
export async function dashboardDrafts(
  d: ReviewDeps,
  draftId: string,
  jurisdictions: ReadonlySet<string>
): Promise<BatchDetail[]> {
  const detail = await dashboardDraft(d, draftId, jurisdictions)
  if (
    !detail ||
    (!detail.plates.length && !Object.keys(detail.batch.stateOrders).length)
  )
    return []
  const { batch, plates } = detail
  return [{ batch, plates }]
}

/** Keep the head revision even when a state loses its last edit or saved order. */
export async function dashboardDraft(
  d: ReviewDeps,
  draftId: string,
  jurisdictions: ReadonlySet<string>
): Promise<(BatchDetail & { orderStates: string[] }) | null> {
  const snapshot = await d.store.readBatch(draftId, jurisdictions)
  if (!snapshot || snapshot.batch.state !== 'open') return null
  const inScope = (plateId: string) => jurisdictions.has(plateId.split('.')[0])
  const { batch, edits } = snapshot
  const plates = await Promise.all(
    edits
      .filter(
        (edit) => inScope(edit.plateId) && Object.keys(edit.fields).length
      )
      .map(async (edit) => {
        const baseline = await d.baselineAtVersion(
          batch.baselineVersion,
          edit.plateId
        )
        return baseline
          ? {
              baseline,
              proposed: { ...baseline, ...edit.fields },
              edit,
              revision: edit.resultRevision,
            }
          : null
      })
  )
  const stateOrders = Object.fromEntries(
    Object.entries(batch.stateOrders).filter(([state]) =>
      jurisdictions.has(state)
    )
  )
  return {
    batch: { ...batch, stateOrders },
    plates: plates.filter((plate) => plate !== null),
    orderStates: Object.keys(batch.stateOrders),
  }
}

/**
 * Build a page of batch differences with baseline plates, draft edits and state ordering
 * changes.
 */
export async function batchDetail(
  d: ReviewDeps,
  batchId: string,
  page?: { offset: number; size: number; revision?: number }
): Promise<Outcome<BatchDetail>> {
  const snapshot = await d.store.readBatch(batchId)
  if (!snapshot) return { ok: false, error: 'not_found' }
  const { batch } = snapshot
  if (page?.revision !== undefined && page.revision !== batch.revision)
    return { ok: false, error: 'superseded_revision' }
  const edits = new Map(snapshot.edits.map((edit) => [edit.plateId, edit]))
  const plates: BatchDetail['plates'] = []
  const orders = new Map<
    string,
    { before: number; after: number; total: number }
  >()
  const ids = new Set(batch.plateIds)
  for (const [state, order] of Object.entries(batch.stateOrders)) {
    const baseline =
      batch.baselineOrders?.[state] ??
      (
        await d.stateBaseline(
          batch.baselineVersion,
          state,
          batch.state === 'published' ? 'snapshot' : undefined
        )
      ).map((plate) => plate.id)
    for (const { plateId, before, after } of orderDifferences(
      baseline,
      order
    )) {
      orders.set(plateId, { before, after, total: baseline.length })
      ids.add(plateId)
    }
  }
  const offset = page?.offset ?? 0
  const end = page ? offset + page.size : ids.size
  for (const plateId of [...ids].slice(offset, end)) {
    const order = orders.get(plateId)
    const baseline = await d.baselineAtVersion(batch.baselineVersion, plateId)
    if (!baseline) return { ok: false, error: 'not_found' }
    const edit = edits.get(plateId) ?? null
    const proposed = { ...baseline, ...edit?.fields }
    plates.push({
      baseline,
      proposed,
      edit,
      revision: plateRevision(proposed),
      ...(order
        ? {
            order: {
              before: order.before,
              after: order.after,
              total: order.total,
            },
          }
        : {}),
    })
  }
  return {
    ok: true,
    value: { batch, plates, ...(end < ids.size ? { nextOffset: end } : {}) },
  }
}
