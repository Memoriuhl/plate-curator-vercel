import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { firestoreCatalogSource } from '../lib/catalog/firestore-source'
import { fixtureSource } from '../lib/catalog/fixture-source'
import type { Plate, Snapshot } from '../lib/catalog/types'
import { db } from './setup'

beforeEach(async () => {
  await Promise.all([
    db.doc('config/catalog').delete(),
    db.doc('curator/workflow').delete(),
  ])
})

afterAll(async () => {
  await Promise.all([
    db.doc('config/catalog').delete(),
    db.doc('curator/workflow').delete(),
  ])
  await db.terminate()
})

test('readSnapshot uses the pointer version', async () => {
  const snapshot: Snapshot = { version: 11, plates: [] }
  const loadSnapshot = vi.fn(async (version: number) => ({
    ...snapshot,
    version,
  }))
  const source = firestoreCatalogSource(db, loadSnapshot)
  await db.doc('config/catalog').set({ version: 11 })
  expect(await source.readSnapshot()).toEqual(snapshot)
  expect(loadSnapshot).toHaveBeenCalledExactlyOnceWith(11)
  await db.doc('config/catalog').set({ version: 12 })
  expect(await source.readSnapshot()).toEqual({ ...snapshot, version: 12 })
  expect(loadSnapshot).toHaveBeenLastCalledWith(12)
})

test.each([null, {}, { version: '11' }])(
  'readSnapshot rejects a missing or nonnumeric pointer: %j',
  async (pointer) => {
    if (pointer) await db.doc('config/catalog').set(pointer)
    const loadSnapshot = vi.fn(async (version: number): Promise<Snapshot> => ({
      version,
      plates: [],
    }))
    await expect(
      firestoreCatalogSource(db, loadSnapshot).readSnapshot()
    ).rejects.toThrow('config/catalog has no numeric version')
    expect(loadSnapshot).not.toHaveBeenCalled()
  }
)

test('curator state defaults to empty', async () => {
  const source = firestoreCatalogSource(db, async (version) => ({
    version,
    plates: [],
  }))
  expect(await source.readCuratorState()).toEqual({
    stateOrder: {},
    stateProgress: {},
  })
  await db.doc('curator/workflow').set({ unrelated: true })
  expect(await source.readCuratorState()).toEqual({
    stateOrder: {},
    stateProgress: {},
  })
})

test('curator state preserves saved fields and defaults each missing field', async () => {
  const source = firestoreCatalogSource(db, async (version) => ({
    version,
    plates: [],
  }))
  await db.doc('curator/workflow').set({ stateOrder: { CA: ['two', 'one'] } })
  expect(await source.readCuratorState()).toEqual({
    stateOrder: { CA: ['two', 'one'] },
    stateProgress: {},
  })
  await db
    .doc('curator/workflow')
    .set({ stateProgress: { CA: 'needs_ordering' } })
  expect(await source.readCuratorState()).toEqual({
    stateOrder: {},
    stateProgress: { CA: 'needs_ordering' },
  })
  await db.doc('curator/workflow').set({
    stateOrder: { CA: ['one'] },
    stateProgress: { CA: 'done' },
    unrelated: true,
  })
  expect(await source.readCuratorState()).toEqual({
    stateOrder: { CA: ['one'] },
    stateProgress: { CA: 'done' },
  })
})

test('imageUrl matches the fixture source', () => {
  const source = firestoreCatalogSource(db, async (version) => ({
    version,
    plates: [],
  }))
  const fixture = fixtureSource()
  const plate: Plate = {
    id: 'one',
    state: 'CA',
    slug: 'one',
    displayName: 'One',
    tags: [],
    image: 'one.png',
  }
  for (const imageUrl of [
    undefined,
    null,
    '',
    42,
    'https://example.com/plate.webp',
  ]) {
    expect(source.imageUrl({ ...plate, imageUrl })).toBe(
      fixture.imageUrl({ ...plate, imageUrl })
    )
  }
})
