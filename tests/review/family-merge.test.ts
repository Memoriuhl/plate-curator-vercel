import { expect, test, vi } from 'vitest'
import { fixtureSource } from '../../lib/catalog/fixture-source'
import { validateSnapshot } from '../../lib/publish/validation'
import { mergeFamily } from '../../lib/review/family-merge'
import { createMemoryStore } from '../../lib/review/memory-store'
import { batchDetail } from '../../lib/review/queries'
import { plateRevision } from '../../lib/review/revision'
import type { Actor, ReviewBatch } from '../../lib/review/types'

const actor: Actor = { uid: 'editor', name: 'Editor', role: 'editor' }
const head = 'AZ.standard'
const radio = 'AZ.amateur_radio'
const life = 'AZ.choose_life'
const target = 'AZ.arizona_science_center'
const removed = 'AZ.arizona_education'
/**
 * Fingerprint the plate to create the revision-bearing reference sent by a merge
 * request.
 */
const reference = (plate: Parameters<typeof plateRevision>[0]) => ({ id: plate.id, revision: plateRevision(plate) })

/**
 * Load fixture families and prepare a scoped review store for testing atomic family
 * moves.
 */
async function setup(destinationId = target) {
  const snapshot = await fixtureSource().readSnapshot()
  const plates = snapshot.plates.filter(plate => plate.state === 'AZ')
  /** Resolve the requested plate from the populated catalog fixture. */
  const plate = (id: string) => plates.find(plate => plate.id === id)!
  // Preserve a legacy slug-only relationship in the exact-version Batch.
  delete plate(life).variantOfPlateId
  const batch: ReviewBatch = {
    id: 'az', name: 'Arizona rehearsal', createdBy: actor.uid, createdByName: actor.name, createdAt: '2026-11-17',
    state: 'open', revision: 3, baselineVersion: snapshot.version, stateOrders: { AZ: plates.map(plate => plate.id) },
    plateIds: [removed], approval: null,
  }
  const store = createMemoryStore([batch])
  const commit = vi.spyOn(store, 'commit')
  const deps = { store, /** Provide the baseline plate data used by the review or job scenario. */ baseline: async (id: string) => plate(id), /** Provide the baseline plate data used by the review or job scenario. */ baselineAtVersion: async (_version: number, id: string) => plate(id),
    /** Return the fixture state order used by the review or queue operation. */
    stateBaseline: async () => plates, /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () => '2026-11-17' }
  const input = { batchId: batch.id, batchRevision: batch.revision, catalogVersion: snapshot.version,
    destination: reference(plate(destinationId)), members: [reference(plate(life)), reference(plate(radio))] }
  return { batch, commit, deps, input, plate, snapshot, store }
}

test('saves eligible Arizona plates together and leaves Standard, deleted plates, and the state order intact', async () => {
  const { batch, commit, deps, input, plate, snapshot, store } = await setup()
  const deleted = { ...plate(removed), deleted: true }
  await store.commit(batch.id, batch.revision, { batch: { ...batch, revision: 4 }, edit: {
    plateId: removed, fields: { deleted: true }, authorId: actor.uid, updatedAt: deps.now(),
    baseRevision: plateRevision(plate(removed)), resultRevision: plateRevision(deleted),
  } })
  commit.mockClear()
  input.members.push(reference(plate(head)), input.destination, reference(deleted))
  expect(await mergeFamily(deps, actor, { ...input, batchRevision: 4 })).toEqual({
    ok: true, value: { moved: [radio, life], alreadyInFamily: 1, deleted: 1, standard: 1 },
  })
  expect(commit).toHaveBeenCalledOnce()
  expect(await store.getBatch(batch.id)).toMatchObject({ revision: 5, lastChangedAt: deps.now(), stateOrders: batch.stateOrders })
  const reloaded = await batchDetail(deps, batch.id)
  if (!reloaded.ok) throw new Error(reloaded.error)
  const proposed = new Map(reloaded.value.plates.map(entry => [entry.proposed.id, entry.proposed]))
  for (const id of [radio, life]) {
    expect(proposed.get(id)).toMatchObject({ templateRole: 'variant', templateFamily: plate(target).templateFamily, variantOfPlateId: target, sortOrder: plate(id).sortOrder })
  }
  expect(proposed.has(head)).toBe(false)
  const candidate = { version: snapshot.version + 1, plates: snapshot.plates.map(plate => plate.id === removed ? plate : proposed.get(plate.id) ?? plate) }
  expect(validateSnapshot(snapshot, candidate, new Set(), batch.stateOrders)).toEqual([])
})

test('a stale Batch or member revision leaves every family field untouched', async () => {
  const { input, deps, store, commit } = await setup()
  const before = await store.readBatch(input.batchId)
  expect(await mergeFamily(deps, actor, { ...input, batchRevision: 2 })).toEqual({ ok: false, error: 'superseded_revision' })
  expect(await mergeFamily(deps, actor, { ...input, members: [input.members[0], { ...input.members[1], revision: 'stale' }] })).toEqual({
    ok: false, error: 'superseded_revision',
  })
  expect(commit).not.toHaveBeenCalled()
  expect(await store.readBatch(input.batchId)).toEqual(before)
})

test('a competing commit rejects the entire move', async () => {
  const { batch, commit, deps, input, store } = await setup()
  const save = store.commit.bind(store)
  commit.mockImplementationOnce(async (...args) => {
    await save(batch.id, batch.revision, { batch: { ...batch, name: 'New name', revision: batch.revision + 1 } })
    return save(...args)
  })
  expect(await mergeFamily(deps, actor, input)).toEqual({ ok: false, error: 'superseded_revision' })
  expect(await store.listEdits(input.batchId)).toEqual([])
  expect(await store.getBatch(input.batchId)).toMatchObject({ name: 'New name', revision: 4 })
})

test('invalid targets and no-op moves create no revision', async () => {
  const invalid = await setup(radio)
  expect(await mergeFamily(invalid.deps, actor, invalid.input)).toMatchObject({ ok: false, error: 'invalid_state' })
  expect(invalid.commit).not.toHaveBeenCalled()
  const unchanged = await setup(head)
  expect(await mergeFamily(unchanged.deps, actor, unchanged.input)).toEqual({
    ok: true, value: { moved: [], alreadyInFamily: 2, deleted: 0, standard: 0 },
  })
  expect(unchanged.commit).not.toHaveBeenCalled()
})

test('a selected Template carries its unselected legacy Variants in the same commit', async () => {
  const { input, deps, plate, store, commit } = await setup()
  const veteran = plate('AZ.veteran')
  const children = (await deps.stateBaseline()).filter(plate => plate.variantOfPlateId === veteran.id)
  expect(children.length).toBeGreaterThan(0)
  expect(await mergeFamily(deps, actor, { ...input, members: [reference(veteran), reference(children[0])] })).toMatchObject({
    ok: true, value: { moved: [veteran.id, ...children.map(plate => plate.id)] },
  })
  expect(commit).toHaveBeenCalledOnce()
  const edits = await store.listEdits(input.batchId)
  expect(edits).toHaveLength(children.length + 1)
  const reloaded = await batchDetail(deps, input.batchId)
  if (!reloaded.ok) throw new Error(reloaded.error)
  expect(reloaded.value.plates.filter(entry => entry.edit).map(entry => entry.proposed)).toEqual(
    [veteran, ...children].map(plate => ({ ...plate, templateRole: 'variant', variantOfPlateId: target, templateFamily: 'az_science_center' })),
  )
})
