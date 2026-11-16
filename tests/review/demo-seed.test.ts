import { describe, expect, it } from 'vitest'
import type { Plate } from '../../lib/catalog/types'
import { approveBatch, proposeEdit, submitBatch } from '../../lib/review/batch'
import { seedDemo } from '../../lib/review/demo-seed'
import { createMemoryStore } from '../../lib/review/memory-store'
import { plateRevision } from '../../lib/review/revision'
import type { ReviewDeps } from '../../lib/review/types'

const editor = { uid: 'demo-editor', name: 'Demo Editor', role: 'editor' } as const
const plates: Plate[] = [
  { id: 'gold', state: 'AK', slug: 'gold', displayName: 'Gold', image: 'AK/gold.webp', tags: ['gold'], templateFamily: 'gold', templateRole: 'template', isStandard: true },
  { id: 'bear', state: 'AK', slug: 'bear', displayName: 'Bear', image: 'AK/bear.webp', tags: ['bear'], templateFamily: 'bear', templateRole: 'template' },
  { id: 'bear-variant', state: 'AK', slug: 'bear-variant', displayName: 'Bear Variant', image: 'AK/bear-variant.webp', tags: ['bear'], templateFamily: 'bear', templateRole: 'variant', variantOfPlateId: 'bear' },
]
const input = { projectId: 'license-plate-game-staging', env: 'development', editor, version: 11 }
function setup(): ReviewDeps {
  return { store: createMemoryStore([]), baseline: async id => plates.find(plate => plate.id === id) ?? null, stateBaseline: async () => structuredClone(plates), now: () => '2026-11-16T12:00:00Z' }
}

describe('demo seed', () => {
  it('creates realistic edits, valid revisions, a regroup and a full reorder, then converges on the same content', async () => {
    const d = setup()
    const first = await seedDemo(d, input)
    const edits = await d.store.listEdits(first.id)
    expect(first).toMatchObject({ state: 'open', baselineVersion: 11, createdByName: 'Demo Editor', plateIds: ['gold', 'bear-variant'], stateOrders: { AK: ['bear', 'bear-variant', 'gold'] } })
    expect(edits.find(edit => edit.plateId === 'gold')?.fields).toMatchObject({ tags: ['gold', 'alaska', 'passenger'], isStandard: false })
    expect({ ...plates[2], ...edits.find(edit => edit.plateId === 'bear-variant')?.fields }).toMatchObject({ templateFamily: 'gold', variantOfPlateId: 'gold', templateRole: 'variant' })
    for (const edit of edits) {
      const baseline = plates.find(plate => plate.id === edit.plateId)!
      expect(edit.baseRevision).toBe(plateRevision(baseline))
      expect(edit.resultRevision).toBe(plateRevision({ ...baseline, ...edit.fields }))
    }
    const second = await seedDemo(d, input)
    expect({ ...second, revision: first.revision }).toEqual(first)
    expect(await d.store.listEdits(first.id)).toEqual(edits)
  })

  it.each(['edited', 'submitted', 'approved'] as const)('resets a %s batch and removes unrelated edits', async state => {
    const d = setup()
    const first = await seedDemo(d, input)
    const seededEdits = await d.store.listEdits(first.id)
    await proposeEdit(d, editor, { batchId: first.id, plateId: 'bear', baseRevision: plateRevision(plates[1]), fields: { tags: ['changed'] } })
    let batch = (await d.store.getBatch(first.id))!
    if (state !== 'edited') {
      await submitBatch(d, editor, first.id, batch.revision)
      batch = (await d.store.getBatch(first.id))!
      if (state === 'approved') await approveBatch(d, { uid: 'owner', name: 'Owner', role: 'owner' }, first.id, batch.revision)
    }
    expect(await seedDemo(d, input)).toMatchObject({ state: 'open', approval: null, plateIds: first.plateIds, stateOrders: first.stateOrders })
    expect(await d.store.listEdits(first.id)).toEqual(seededEdits)
  })

  it('leaves a published batch and its edits untouched', async () => {
    const d = setup()
    const first = await seedDemo(d, input)
    const published = { ...first, state: 'published' as const, revision: first.revision + 1 }
    await d.store.commit(first.id, first.revision, { batch: published })
    const edits = await d.store.listEdits(first.id)
    await expect(seedDemo(d, input)).rejects.toThrow('Published')
    expect(await d.store.getBatch(first.id)).toEqual(published)
    expect(await d.store.listEdits(first.id)).toEqual(edits)
  })

  it.each(['other-project', '', 'license-plate-game-staging-copy'])('refuses project %s before touching dependencies', async projectId => {
    const d = setup()
    d.store.getBatch = async () => { throw new Error('Store must not be called') }
    await expect(seedDemo(d, { ...input, projectId })).rejects.toThrow('requires the staging project')
  })

  it('keeps review environments and Editors separate', async () => {
    const d = setup()
    const first = await seedDemo(d, input)
    const preview = await seedDemo(d, { ...input, env: 'preview:feature/demo' })
    const other = await seedDemo(d, { ...input, editor: { ...editor, uid: 'another-editor' } })
    expect(new Set([first.id, preview.id, other.id]).size).toBe(3)
    expect(await d.store.getBatch(first.id)).toEqual(first)
  })

  it('stops on a concurrent reset without overwriting it', async () => {
    const d = setup()
    const first = await seedDemo(d, input)
    const before = await d.store.listEdits(first.id)
    d.store.commit = async () => 'revision_mismatch'
    await expect(seedDemo(d, input)).rejects.toThrow('changed during reset')
    expect(await d.store.getBatch(first.id)).toEqual(first)
    expect(await d.store.listEdits(first.id)).toEqual(before)
  })
})
