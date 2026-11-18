import { expect, test, vi } from 'vitest'
import { fixtureSource } from '../../lib/catalog/fixture-source'
import {
  buildDashboard,
  buildJurisdiction,
  buildPlate,
} from '../../lib/catalog/dashboard-build'

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ cacheLife: vi.fn() }))

const { cachedDashboard, cachedJurisdiction } =
  await import('../../lib/server/snapshot-cache')

test('versioned jurisdiction entries preserve cards, detail and live ordering without other jurisdictions', async () => {
  const source = fixtureSource()
  const snapshot = await source.readSnapshot()
  const slice = await cachedJurisdiction(11, 'AK', 'fixture')
  expect(slice.version).toBe(11)
  expect(slice.plates).toHaveLength(44)
  expect(slice.plates.every((plate) => plate.state === 'AK')).toBe(true)
  const curator = {
    stateOrder: { AK: ['AK.amateur_radio_call_sign', 'AK.standard_gold'] },
    stateProgress: {},
  }
  expect(buildJurisdiction(slice, curator, source.imageUrl, 'AK')).toEqual(
    buildJurisdiction(snapshot, curator, source.imageUrl, 'AK')
  )
  expect(
    buildPlate(slice, curator, source.imageUrl, 'AK.standard_gold')
  ).toEqual(buildPlate(snapshot, curator, source.imageUrl, 'AK.standard_gold'))
  expect(await cachedJurisdiction(11, 'XX', 'fixture')).toEqual({
    version: 11,
    plates: [],
  })
})

test('cached summary matches catalog counts and completeness without storing curator progress', async () => {
  const source = fixtureSource('https://example.com/images')
  const snapshot = await source.readSnapshot()
  expect(
    await cachedDashboard(11, 'fixture', 'https://example.com/images')
  ).toEqual(
    buildDashboard(
      snapshot,
      { stateOrder: {}, stateProgress: {} },
      source.imageUrl
    )
  )
  expect((await cachedDashboard(11, 'fixture', null)).jurisdictions[0]).toEqual(
    {
      code: 'AK',
      name: 'Alaska',
      region: 'US',
      plateCount: 44,
      completeCount: 0,
      progress: null,
    }
  )
  await expect(cachedDashboard(12, 'fixture', null)).rejects.toThrow(
    'Fixture catalog v12 unavailable'
  )
})
