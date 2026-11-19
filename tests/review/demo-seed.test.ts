import { describe, expect, it } from 'vitest'
import type { Plate } from '../../lib/catalog/types'
import { proposeEdit } from '../../lib/review/batch'
import { approveBatch, submitBatch } from '../helpers/legacy-approval'
import { seedDemo } from '../../lib/review/demo-seed'
import { createMemoryStore } from '../../lib/review/memory-store'
import { plateRevision } from '../../lib/review/revision'
import type { ReviewDeps } from '../../lib/review/types'

const editor = {
  uid: 'demo-editor',
  name: 'Demo Editor',
  role: 'editor',
} as const
const plates: Plate[] = [
  {
    id: 'gold',
    state: 'AK',
    slug: 'gold',
    displayName: 'Gold',
    image: 'AK/gold.webp',
    tags: ['gold'],
    templateFamily: 'gold',
    templateRole: 'template',
    isStandard: true,
  },
  {
    id: 'bear',
    state: 'AK',
    slug: 'bear',
    displayName: 'Bear',
    image: 'AK/bear.webp',
    tags: ['bear'],
    templateFamily: 'bear',
    templateRole: 'template',
  },
  {
    id: 'bear-variant',
    state: 'AK',
    slug: 'bear-variant',
    displayName: 'Bear Variant',
    image: 'AK/bear-variant.webp',
    tags: ['bear'],
    templateFamily: 'bear',
    templateRole: 'variant',
    variantOfPlateId: 'bear',
  },
]
const input = {
  projectId: 'license-plate-game-staging',
  env: 'development',
  editor,
  version: 11,
}
/**
 * Prepare a controlled store and snapshot for deterministic demonstration batch seeding.
 */
function setup(): ReviewDeps & { store: ReturnType<typeof createMemoryStore> } {
  return {
    store: createMemoryStore([]),
    /** Resolve the plate by ID from the fixture baseline. */ baselineAtVersion:
      async (_version, id) => plates.find((plate) => plate.id === id) ?? null,
    /** Resolve the plate by ID from the fixture baseline. */ baseline: async (
      id
    ) => plates.find((plate) => plate.id === id) ?? null,
    /** Return the fixture state order used by the review or queue operation. */ stateBaseline:
      async () => structuredClone(plates),
    /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () =>
      '2026-11-16T12:00:00Z',
  }
}

describe('demo seed', () => {
  it('creates realistic edits, valid revisions, a regroup and a full reorder, then converges on the same content', async () => {
    const d = setup()
    const first = await seedDemo(d, input)
    expect(d.store.signalRevision(first.id)).toBe(first.revision)
    const edits = await d.store.listEdits(first.id)
    expect(first).toMatchObject({
      id: 'demo-development-demo-editor',
      state: 'open',
      baselineVersion: 11,
      createdByName: 'Demo Editor',
      plateIds: ['gold', 'bear-variant', 'bear'],
      stateOrders: { AK: ['bear', 'gold', 'bear-variant'] },
    })
    expect(edits.find((edit) => edit.plateId === 'gold')?.fields).toMatchObject(
      { tags: ['gold', 'alaska', 'passenger'], isStandard: false }
    )
    expect({
      ...plates[2],
      ...edits.find((edit) => edit.plateId === 'bear-variant')?.fields,
    }).toMatchObject({
      templateFamily: 'gold',
      variantOfPlateId: 'gold',
      templateRole: 'variant',
    })
    for (const edit of edits) {
      const baseline = plates.find((plate) => plate.id === edit.plateId)!
      expect(edit.baseRevision).toBe(plateRevision(baseline))
      expect(edit.resultRevision).toBe(
        plateRevision({ ...baseline, ...edit.fields })
      )
    }
    const second = await seedDemo(d, input)
    expect(second.revision).toBeGreaterThan(first.revision)
    expect(d.store.signalRevision(second.id)).toBe(second.revision)
    expect({ ...second, revision: first.revision }).toEqual(first)
    expect(await d.store.listEdits(first.id)).toEqual(edits)
  })

  it.each(['edited', 'submitted', 'approved'] as const)(
    'resets a %s batch and removes unrelated edits',
    async (state) => {
      const d = setup()
      const first = await seedDemo(d, input)
      const seededEdits = await d.store.listEdits(first.id)
      await proposeEdit(d, editor, {
        batchId: first.id,
        plateId: 'bear',
        baseRevision: plateRevision(plates[1]),
        fields: { tags: ['changed'] },
      })
      let batch = (await d.store.getBatch(first.id))!
      if (state !== 'edited') {
        await submitBatch(d, editor, first.id, batch.revision)
        batch = (await d.store.getBatch(first.id))!
        if (state === 'approved')
          await approveBatch(
            d,
            { uid: 'owner', name: 'Owner', role: 'owner' },
            first.id,
            batch.revision
          )
      }
      const reset = await seedDemo(d, input)
      expect(reset).toMatchObject({
        state: 'open',
        approval: null,
        plateIds: first.plateIds,
        stateOrders: first.stateOrders,
      })
      expect(reset.revision).toBeGreaterThan(batch.revision)
      expect(d.store.signalRevision(reset.id)).toBe(reset.revision)
      expect(await d.store.listEdits(first.id)).toEqual(seededEdits)
    }
  )

  it('seeds generation 2 when the base batch is published and leaves it untouched', async () => {
    const d = setup()
    const first = await seedDemo(d, input)
    const published = {
      ...first,
      state: 'published' as const,
      revision: first.revision + 1,
    }
    await d.store.commit(first.id, first.revision, { batch: published })
    const edits = await d.store.listEdits(first.id)
    const fresh = await seedDemo(d, input)
    expect(fresh).toEqual({ ...first, id: `${first.id}-2` })
    expect(await d.store.listEdits(fresh.id)).toEqual(edits)
    expect(await d.store.getBatch(first.id)).toEqual(published)
    expect(await d.store.listEdits(first.id)).toEqual(edits)
  })

  it('seeds generation 3 when the base and generation 2 batches are published', async () => {
    const d = setup()
    const first = await seedDemo(d, input)
    const published = {
      ...first,
      state: 'published' as const,
      revision: first.revision + 1,
    }
    await d.store.commit(first.id, first.revision, { batch: published })
    const fresh = await seedDemo(d, input)
    const freshPublished = {
      ...fresh,
      state: 'published' as const,
      revision: fresh.revision + 1,
    }
    await d.store.commit(fresh.id, fresh.revision, { batch: freshPublished })
    const edits = await d.store.listEdits(fresh.id)
    const third = await seedDemo(d, input)
    expect(third).toEqual({ ...first, id: `${first.id}-3` })
    expect(await d.store.listEdits(third.id)).toEqual(edits)
    expect(await d.store.getBatch(first.id)).toEqual(published)
    expect(await d.store.getBatch(fresh.id)).toEqual(freshPublished)
    expect(await d.store.listEdits(fresh.id)).toEqual(edits)
  })

  it('resets an unpublished generation 2 batch when the base batch is published', async () => {
    const d = setup()
    const first = await seedDemo(d, input)
    const published = {
      ...first,
      state: 'published' as const,
      revision: first.revision + 1,
    }
    await d.store.commit(first.id, first.revision, { batch: published })
    const fresh = await seedDemo(d, input)
    const edits = await d.store.listEdits(fresh.id)
    await proposeEdit(d, editor, {
      batchId: fresh.id,
      plateId: 'bear',
      baseRevision: plateRevision(plates[1]),
      fields: { tags: ['changed'] },
    })
    const reset = await seedDemo(d, input)
    expect(reset.revision).toBeGreaterThan(fresh.revision)
    expect(d.store.signalRevision(reset.id)).toBe(reset.revision)
    expect(reset.id).toBe(`${first.id}-2`)
    expect({ ...reset, revision: fresh.revision }).toEqual(fresh)
    expect(await d.store.listEdits(reset.id)).toEqual(edits)
    expect(await d.store.getBatch(first.id)).toEqual(published)
  })

  it.each([1, 2])(
    'rejects an owner mismatch in generation %s',
    async (generation) => {
      const d = setup()
      let batch = await seedDemo(d, input)
      if (generation === 2) {
        await d.store.commit(batch.id, batch.revision, {
          batch: { ...batch, state: 'published', revision: batch.revision + 1 },
        })
        batch = await seedDemo(d, input)
      }
      const otherOwner = {
        ...batch,
        createdBy: 'another-editor',
        revision: batch.revision + 1,
      }
      await d.store.commit(batch.id, batch.revision, { batch: otherOwner })
      const edits = await d.store.listEdits(batch.id)
      await expect(seedDemo(d, input)).rejects.toThrow(
        'Demo batch owner mismatch'
      )
      expect(await d.store.getBatch(batch.id)).toEqual(otherOwner)
      expect(d.store.signalRevision(batch.id)).toBe(otherOwner.revision)
      expect(await d.store.listEdits(batch.id)).toEqual(edits)
    }
  )

  it.each(['other-project', '', 'license-plate-game-staging-copy'])(
    'refuses project %s before touching dependencies',
    async (projectId) => {
      const d = setup()
      d.store.getBatch = async () => {
        throw new Error('Store must not be called')
      }
      await expect(seedDemo(d, { ...input, projectId })).rejects.toThrow(
        'requires the staging project'
      )
    }
  )

  it('keeps review environments and Editors separate', async () => {
    const d = setup()
    const first = await seedDemo(d, input)
    const preview = await seedDemo(d, { ...input, env: 'preview:feature/demo' })
    const other = await seedDemo(d, {
      ...input,
      editor: { ...editor, uid: 'another-editor' },
    })
    expect(new Set([first.id, preview.id, other.id]).size).toBe(3)
    for (const batch of [first, preview, other])
      expect(d.store.signalRevision(batch.id)).toBe(batch.revision)
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
    expect(d.store.signalRevision(first.id)).toBe(first.revision)
  })
})

it('demo rotation keeps Variants in the first family with their Template', async () => {
  const d = setup()
  const variant: Plate = {
    ...plates[2],
    id: 'gold-variant',
    slug: 'gold-variant',
    templateFamily: 'gold',
    variantOfPlateId: 'gold',
  }
  const inputPlates = [plates[0], variant, plates[1], plates[2]]
  d.stateBaseline = async () => inputPlates
  d.baselineAtVersion = async (_version, id) =>
    inputPlates.find((plate) => plate.id === id) ?? null
  const batch = await seedDemo(d, input)
  expect(batch.stateOrders.AK).toEqual([
    'bear',
    'gold',
    'gold-variant',
    'bear-variant',
  ])
  expect(await d.store.getEdit(batch.id, 'bear')).toMatchObject({
    fields: { isStandard: true },
  })
})
