import { proposeEdit, reorderState } from './batch'
import { plateRevision } from './revision'
import type { Actor, EditableFields, ReviewBatch, ReviewDeps } from './types'
import type { Plate } from '../catalog/types'

export function assertStagingProject(projectId: string | undefined): void {
  if (projectId !== 'license-plate-game-staging') throw new Error('Demo seed requires the staging project')
}

export async function seedDemo(d: ReviewDeps, input: { projectId: string; env: string; editor: Actor; version: number }): Promise<ReviewBatch> {
  assertStagingProject(input.projectId)
  if (!/^(development|production|preview:.+)$/.test(input.env)) throw new Error('Invalid review environment')
  if (input.editor.role !== 'editor' || !input.editor.uid.trim() || !input.editor.name?.trim()) throw new Error('Editor uid and display name required')
  const baseId = `demo-${encodeURIComponent(input.env)}-${encodeURIComponent(input.editor.uid)}`
  let id = baseId
  let existing = await d.store.getBatch(id)
  for (let generation = 2; existing?.state === 'published'; generation += 1) {
    id = `${baseId}-${generation}`
    existing = await d.store.getBatch(id)
  }
  if (existing && existing.createdBy !== input.editor.uid) throw new Error('Demo batch owner mismatch')
  const plates = await d.stateBaseline(input.version, 'AK')
  const target = plates.find(plate => plate.templateRole === 'template' && plate.templateFamily)
  const moved = plates.find(plate => plate.templateRole === 'variant' && plate.templateFamily !== target?.templateFamily)
  if (!target || !moved || plates.length < 3) throw new Error('AK requires a Template and a Plate from another family')
  let batch: ReviewBatch = {
    id, name: 'Demo: Alaska field edits and grouping', createdBy: input.editor.uid, createdByName: input.editor.name,
    createdAt: d.now(), state: 'open', revision: existing ? existing.revision + 1 : 0,
    baselineVersion: input.version, stateOrders: {}, plateIds: [], approval: null,
  }
  if (existing) {
    if (await d.store.commit(id, existing.revision, { batch }) !== 'ok') throw new Error('Demo batch changed during reset')
    for (const edit of await d.store.listEdits(id)) {
      const next = { ...batch, revision: batch.revision + 1 }
      if (await d.store.commit(id, batch.revision, { batch: next, deleteEditFor: edit.plateId }) !== 'ok') throw new Error('Demo batch changed during reset')
      batch = next
    }
  } else if (await d.store.create(batch) !== 'ok') throw new Error('Demo batch already exists')
  const edits: [Plate, EditableFields][] = [
    [target, { tags: [...new Set([...target.tags, 'alaska', 'passenger'])], description: `${target.displayName}: an Alaska passenger plate selected for the review demo.` }],
    [moved, { templateFamily: target.templateFamily, templateRole: 'variant' as const, variantOfPlateId: target.id }],
  ]
  for (const [plate, fields] of edits) {
    const result = await proposeEdit(d, input.editor, { batchId: id, plateId: plate.id, baseRevision: plateRevision(plate), fields })
    if (!result.ok) throw new Error(`Demo edit failed: ${result.error}`)
  }
  const current = await d.store.getBatch(id)
  if (!current) throw new Error('Demo batch disappeared')
  const order = plates.map(plate => plate.id)
  const result = await reorderState(d, input.editor, { batchId: id, state: 'AK', batchRevision: current.revision, order: [...order.slice(1), order[0]], standard: { from: plates.find(plate => plate.isStandard)?.id ?? null, to: order[1] } })
  if (!result.ok) throw new Error(`Demo reorder failed: ${result.error}`)
  return result.value
}
