import { expect, test } from 'vitest'
import { plateCards } from '../fixtures/plate-cards'
import { PLATE_CHECK_KEYS } from '../lib/catalog/dashboard-types'
import { filterCounts, matchesPlate, NEEDS_WORK_CHECKS, plateIdsForCheck } from '../components/dashboard/family-data'

const plates = ['missing', 'weak', 'good'].map((status, index) => ({
  ...plateCards[0], id: `AK.${index}`, state: 'AK', isStandard: index === 0,
  checks: Object.fromEntries(PLATE_CHECK_KEYS.map(key => [key, { status, value: null }])) as typeof plateCards[0]['checks'],
}))

test('every available health category counts exactly the IDs returned by its helper', () => {
  const counts = filterCounts(plates)
  for (const { key } of NEEDS_WORK_CHECKS) {
    expect(counts.groups[key].ids).toEqual(plateIdsForCheck(plates, key))
    expect(counts.groups[key].total).toBe(plateIdsForCheck(plates, key).length)
  }
  expect(counts.groups.missingDescription).toMatchObject({ missing: 1, weak: 0, total: 1 })
  expect(counts.groups.generic).toMatchObject({ missing: 1, weak: 1, total: 2 })
  expect(counts.groups.undertagged).toMatchObject({ missing: 1, weak: 1, total: 2 })
  expect(counts.groups.noFamily.total).toBe(2)
  expect(counts.groups.nofunfacts.total).toBe(1)
})

test('unsourced facts require an existing fact and a missing link', () => {
  const unsourced = { ...plates[2], checks: { ...plates[2].checks, link: { status: 'missing' as const, value: null } } }
  expect(plateIdsForCheck([...plates, unsourced], 'unsourcedFact')).toEqual([unsourced.id])
})

test('legacy URLs retain their missing-only or non-good behavior', () => {
  expect(plateIdsForCheck(plates, 'nofunfacts')).toEqual(['AK.0'])
  expect(plateIdsForCheck(plates, 'undertagged')).toEqual(['AK.0', 'AK.1'])
  expect(plateIdsForCheck(plates, 'generic')).toEqual(['AK.0', 'AK.1'])
  for (const { key } of NEEDS_WORK_CHECKS.filter(check => check.key !== 'standardPlate')) {
    expect(plates.filter(plate => matchesPlate(plate, key, '', new Set())).map(plate => plate.id)).toEqual(plateIdsForCheck(plates, key))
  }
  expect(plateIdsForCheck(plates, 'unknown')).toEqual([])
  expect(plateIdsForCheck([], 'standardPlate')).toEqual([])
})

test('standard-plate fixes span states, selecting duplicates or the first candidate when absent', () => {
  const input = [
    { ...plates[0], isStandard: true }, { ...plates[1], isStandard: true },
    { ...plates[2], id: 'NY.later', state: 'NY', isStandard: false, sortOrder: 9 },
    { ...plates[2], id: 'NY.first', state: 'NY', isStandard: false, sortOrder: 0 },
    { ...plates[0], id: 'CA.only', state: 'CA', isStandard: true },
  ]
  const ids = plateIdsForCheck(input, 'standardPlate')
  expect(ids).toEqual(['AK.0', 'AK.1', 'NY.first'])
  expect(filterCounts(input).groups.standardPlate.ids).toEqual(ids)
  expect(input.filter(plate => matchesPlate(plate, 'standardPlate', '', new Set(), new Set(ids))).map(plate => plate.id)).toEqual(ids)
  expect(matchesPlate(input[0], 'standardPlate', 'no match', new Set(), new Set(ids))).toBe(false)
})
