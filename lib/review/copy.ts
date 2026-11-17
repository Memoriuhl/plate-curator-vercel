import { standardOrderProblems } from './standard'
import { createHash } from 'node:crypto'
import type { Snapshot } from '../catalog/types'
import { orderedStatePlates } from '../catalog/order'
import { plateRevision } from './revision'
import type { Actor, CopyCommitResult, ProposedEdit, ReviewStore } from './types'

export type CopyDeps = {
  store: ReviewStore
  head(): Promise<number>
  snapshot(version: number): Promise<Snapshot>
  now(): string
  env: string
}
export type CopyOutcome = CopyCommitResult | { ok: false; error: 'forbidden' | 'incompatible'; reasons?: string[] }

export function copyBatchId(env: string, sourceId: string, revision: number, version: number) {
  return `copy-${createHash('sha256').update(JSON.stringify([env, sourceId, revision, version])).digest('hex')}`
}

export async function copyBatch(d: CopyDeps, actor: Actor, input: { sourceId: string; sourceRevision: number; targetVersion: number }): Promise<CopyOutcome> {
  if (actor.role !== 'owner') return { ok: false, error: 'forbidden' }
  const id = copyBatchId(d.env, input.sourceId, input.sourceRevision, input.targetVersion)
  const existing = await d.store.getBatch(id)
  if (existing) return { ok: true, value: existing }
  const source = await d.store.readBatch(input.sourceId)
  if (!source) return { ok: false, error: 'not_found' }
  if (source.batch.revision !== input.sourceRevision) return { ok: false, error: 'superseded_revision' }
  if (source.batch.state !== 'approved') return { ok: false, error: 'invalid_state' }
  const liveVersion = await d.head()
  if (liveVersion !== input.targetVersion) return { ok: false, error: 'head_moved', liveVersion }
  const snapshot = await d.snapshot(input.targetVersion)
  if (snapshot.version !== input.targetVersion) throw new Error('Copy baseline unavailable')
  const plates = new Map(snapshot.plates.map(plate => [plate.id, plate]))
  const reasons: string[] = []
  for (const plateId of new Set([...source.batch.plateIds, ...source.edits.map(edit => edit.plateId)])) {
    if (!plates.has(plateId)) reasons.push(`Missing Plate: ${plateId}`)
  }
  for (const edit of source.edits) {
    const parent = edit.fields.variantOfPlateId
    if (parent && !plates.has(parent)) reasons.push(`Missing Variant parent: ${parent} (${edit.plateId})`)
  }
  const baselineOrders: Record<string, string[]> = {}
  for (const [state, order] of Object.entries(source.batch.stateOrders)) {
    const current = orderedStatePlates(snapshot, state, { stateOrder: {}, stateProgress: {} }).map(plate => plate.id)
    const ids = new Set(current)
    if (order.length !== ids.size || new Set(order).size !== order.length || order.some(id => !ids.has(id))) reasons.push(`State order no longer matches Jurisdiction: ${state}`)
    baselineOrders[state] = current
  }
  if (!reasons.length) reasons.push(...standardOrderProblems(snapshot.plates, source.edits, source.batch.stateOrders))
  if (reasons.length) return { ok: false, error: 'incompatible', reasons }
  const now = d.now()
  const edits: ProposedEdit[] = source.edits.map(edit => {
    const baseline = plates.get(edit.plateId)!
    return { plateId: edit.plateId, fields: structuredClone(edit.fields), baseRevision: plateRevision(baseline), resultRevision: plateRevision({ ...baseline, ...edit.fields }), authorId: actor.uid, updatedAt: now }
  })
  return d.store.copy({ ...input, batch: {
    id, name: `${source.batch.name} (fresh review)`, createdBy: actor.uid, createdByName: actor.name, createdAt: now,
    state: 'open', revision: 0, baselineVersion: input.targetVersion, approval: null,
    source: { batchId: input.sourceId, revision: input.sourceRevision },
    plateIds: [...source.batch.plateIds], stateOrders: structuredClone(source.batch.stateOrders), baselineOrders,
  }, edits })
}
