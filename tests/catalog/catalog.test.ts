import { expect, test } from 'vitest'
import { fixtureSource } from '../../lib/catalog/fixture-source'
import { stateSummaries } from '../../lib/catalog/home'
import { orderedStatePlates } from '../../lib/catalog/order'
import type { CuratorState, Plate, Snapshot } from '../../lib/catalog/types'

function plate(id: string, sortOrder?: number, state = 'AK'): Plate {
  return { id, state, slug: id, displayName: id, tags: [], image: '', sortOrder }
}

const snapshot: Snapshot = {
  version: 11,
  plates: [plate('z'), plate('b', 2), plate('a', 2), plate('c', 0), plate('y'), plate('az', 0, 'AZ')],
}

function curator(order: string[] = []): CuratorState {
  return { stateOrder: { AK: order }, stateProgress: {} }
}

test('uses the saved State order', () => {
  expect(orderedStatePlates(snapshot, 'AK', curator(['z', 'b', 'a', 'y', 'c'])).map(p => p.id))
    .toEqual(['z', 'b', 'a', 'y', 'c'])
})

test('falls back to sortOrder when the state has no saved order', () => {
  expect(orderedStatePlates(snapshot, 'AK', { stateOrder: {}, stateProgress: {} }).map(p => p.id))
    .toEqual(['c', 'a', 'b', 'y', 'z'])
})

test('puts plates missing from the saved order after the ordered ones, by sortOrder', () => {
  expect(orderedStatePlates(snapshot, 'AK', curator(['z'])).map(p => p.id))
    .toEqual(['z', 'c', 'a', 'b', 'y'])
})

test('skips saved ids that no longer exist', () => {
  expect(orderedStatePlates(snapshot, 'AK', curator(['gone', 'az', 'z'])).map(p => p.id))
    .toEqual(['z', 'c', 'a', 'b', 'y'])
})

test('fixture source returns only AK, AZ and CO plates at version 11', async () => {
  const source = fixtureSource()
  const result = await source.readSnapshot()
  expect(result.version).toBe(11)
  expect([...new Set(result.plates.map(p => p.state))].sort()).toEqual(['AK', 'AZ', 'CO'])
  expect(result.plates.every(p => p.id && p.image && Array.isArray(p.tags))).toBe(true)
  expect(await source.readCuratorState()).toEqual({ stateOrder: {}, stateProgress: {} })
})

test('imageUrl is null when the plate has no imageUrl', () => {
  const source = fixtureSource()
  expect(source.imageUrl(plate('a'))).toBeNull()
  for (const imageUrl of ['', 42, null, undefined]) {
    expect(source.imageUrl({ ...plate('a'), imageUrl })).toBeNull()
  }
  expect(source.imageUrl({ ...plate('a'), imageUrl: 'https://example.com/plate.webp' }))
    .toBe('https://example.com/plate.webp')
})

test('stateSummaries counts plates per state and reports progress or null', () => {
  expect(stateSummaries({ ...snapshot, plates: [...snapshot.plates].reverse() }, {
    stateOrder: {}, stateProgress: { AK: 'needs_ordering', CO: 'done' },
  })).toEqual([
    { state: 'AK', plateCount: 5, progress: 'needs_ordering' },
    { state: 'AZ', plateCount: 1, progress: null },
  ])
  expect(stateSummaries({ version: 11, plates: [] }, curator())).toEqual([])
})
