import { expect, test } from 'vitest'
import { buildDashboard, buildJurisdiction, buildPlate } from '../../lib/catalog/dashboard-build'
import { plateRevision } from '../../lib/review/revision'
import type { Plate } from '../../lib/catalog/types'
import { fixtureSource } from '../../lib/catalog/fixture-source'

const source = fixtureSource()

async function fixture() {
  return { snapshot: await source.readSnapshot(), curator: await source.readCuratorState() }
}

test('dashboard reports fixture jurisdictions, counts and current progress sorted by name', async () => {
  const { snapshot, curator } = await fixture()
  curator.stateProgress.AK = 'needs_ordering'
  expect(buildDashboard(snapshot, curator, source.imageUrl)).toEqual({
    catalogVersion: 11,
    jurisdictions: [
      { code: 'AK', name: 'Alaska', region: 'US', plateCount: 44, completeCount: 0, progress: 'needs_ordering' },
      { code: 'AZ', name: 'Arizona', region: 'US', plateCount: 99, completeCount: 0, progress: null },
      { code: 'CO', name: 'Colorado', region: 'US', plateCount: 313, completeCount: 0, progress: null },
    ],
  })
  expect(buildDashboard({ version: 12, plates: [] }, curator, source.imageUrl)).toEqual({ catalogVersion: 12, jurisdictions: [] })
})

test('jurisdiction cards use saved order, review revisions, fixed image sizes and defaults', async () => {
  const { snapshot, curator } = await fixture()
  curator.stateOrder.AK = ['AK.amateur_radio_call_sign', 'AK.standard_gold']
  const before = structuredClone({ snapshot, curator })
  const result = buildJurisdiction(snapshot, curator, source.imageUrl, 'AK')!
  expect(result).toMatchObject({ code: 'AK', name: 'Alaska', region: 'US' })
  expect(result.plates.slice(0, 3).map(plate => plate.id)).toEqual(['AK.amateur_radio_call_sign', 'AK.standard_gold', 'AK.grizzly_bear'])
  expect(result.plates[0]).toMatchObject({
    slug: 'amateur_radio_call_sign', displayName: 'Amateur Radio (Call Sign)',
    imageUrl: null, imageSize: { width: 320, height: 160 }, isStandard: false,
    sortOrder: 1, templateFamily: 'AK.standard_gold', templateRole: 'variant',
    variantOfPlateId: 'AK.standard_gold', complete: false,
  })
  expect(result.plates[0].revision).toBe(plateRevision(snapshot.plates.find(plate => plate.id === result.plates[0].id)!))
  expect(result.plates[1].isStandard).toBe(true)
  expect(buildJurisdiction(snapshot, curator, source.imageUrl, 'XX')).toBeNull()
  expect({ snapshot, curator }).toEqual(before)
})

test('plate detail follows state order for neighbours and same-jurisdiction family members', async () => {
  const { snapshot, curator } = await fixture()
  curator.stateOrder.AK = ['AK.amateur_radio_call_sign', 'AK.grizzly_bear', 'AK.standard_gold']
  snapshot.plates.push({ ...snapshot.plates[0], id: 'AZ.same_family', state: 'AZ' })
  const result = buildPlate(snapshot, curator, source.imageUrl, 'AK.standard_gold')!
  expect(result.prevId).toBe('AK.grizzly_bear')
  expect(result.nextId).toBe('AK.celebrating_the_arts')
  expect(result.family.map(plate => plate.id)).toEqual(['AK.amateur_radio_call_sign', 'AK.standard_gold'])
  expect(result.plate).toMatchObject({
    description: 'The Standard Gold is a standard-issue license plate option for passenger vehicles and motorcycles in Alaska.',
    category: null, wikiUrl: 'https://licenseplates.cc/AK',
    sourceUrl: 'https://doa.alaska.gov/dmv/plates/Images/Standard/blue-n-gold.png',
  })
  expect(buildPlate(snapshot, curator, source.imageUrl, 'AK.amateur_radio_call_sign')!.prevId).toBeNull()
  const last = buildJurisdiction(snapshot, curator, source.imageUrl, 'AK')!.plates.at(-1)!
  expect(buildPlate(snapshot, curator, source.imageUrl, last.id)!.nextId).toBeNull()
  expect(buildPlate(snapshot, curator, source.imageUrl, 'missing')).toBeNull()
})

async function detail(overrides: Partial<Plate> = {}) {
  const { snapshot, curator } = await fixture()
  const plate: Plate = {
    ...snapshot.plates[0], description: undefined, sourceUrl: undefined, wikiUrl: undefined,
    tags: [], templateFamily: undefined, templateRole: undefined, isStandard: undefined,
    variantOfPlateId: undefined, sortOrder: undefined, ...overrides,
  }
  return buildPlate({ ...snapshot, plates: [plate] }, curator, source.imageUrl, plate.id)!
}

test('missing metadata produces missing checks, null hover text and card defaults', async () => {
  const result = await detail()
  expect(result.plate.checks).toEqual({
    description: { status: 'missing', value: null }, funFacts: { status: 'missing', value: null },
    link: { status: 'missing', value: null }, tags: { status: 'missing', value: null },
    family: { status: 'missing', value: null }, image: { status: 'missing', value: null },
    rarity: { status: 'missing', value: null },
  })
  expect(result.plate).toMatchObject({ isStandard: false, sortOrder: 0, templateFamily: null, templateRole: null, variantOfPlateId: null, complete: false, description: null, category: null })
  expect(result.family).toEqual([])
  expect(result.prevId).toBeNull()
  expect(result.nextId).toBeNull()
})

test('weak checks preserve full hover text', async () => {
  const result = await detail({ description: 'x'.repeat(39), wikiUrl: 'https://example.com/wiki', tags: ['red', 'blue'], templateFamily: 'family' })
  expect(result.plate.checks).toMatchObject({
    description: { status: 'weak', value: 'x'.repeat(39) },
    link: { status: 'weak', value: 'https://example.com/wiki' },
    tags: { status: 'weak', value: 'red, blue' },
    family: { status: 'weak', value: 'family' },
  })
  expect(result.plate.complete).toBe(false)
})

test('complete counts use only the completeness keys and preserve full good values', async () => {
  const { snapshot, curator } = await fixture()
  const plate = {
    ...snapshot.plates[0], description: 'x'.repeat(40), tags: ['one', 'two', 'three'],
    imageUrl: 'https://example.com/plate.webp',
  }
  const result = buildPlate({ ...snapshot, plates: [plate] }, curator, source.imageUrl, plate.id)!
  expect(result.plate.checks).toEqual({
    description: { status: 'good', value: 'x'.repeat(40) },
    funFacts: { status: 'missing', value: null },
    link: { status: 'good', value: 'https://doa.alaska.gov/dmv/plates/Images/Standard/blue-n-gold.png' },
    tags: { status: 'good', value: 'one, two, three' },
    family: { status: 'good', value: 'AK.standard_gold · template' },
    image: { status: 'good', value: 'https://example.com/plate.webp' },
    rarity: { status: 'missing', value: null },
  })
  expect(result.plate.complete).toBe(true)
  expect(buildDashboard({ ...snapshot, plates: [plate, { ...plate, id: 'AK.incomplete', tags: [] }] }, curator, source.imageUrl).jurisdictions[0].completeCount).toBe(1)
})

test.each([
  [undefined, 'missing', null], ['', 'missing', null], [[], 'missing', null],
  [42, 'missing', null], ['A fact', 'good', 'A fact'],
  [['First fact', 'Second fact'], 'good', 'First fact\nSecond fact'],
  [[''], 'good', ''],
] as const)('fun facts %j produce %s', async (funFacts, status, value) => {
  expect((await detail({ funFacts: funFacts as unknown as Plate['funFacts'] })).plate.checks.funFacts).toEqual({ status, value })
})

test.each(['rare', { tier: 'rare' }])('rarity returns the tier text for %j', async rarity => {
  expect((await detail({ rarity })).plate.checks.rarity).toEqual({ status: 'good', value: 'rare' })
})

test.each(['DC', 'AS', 'GU', 'MP', 'PR', 'VI', 'UM', 'CA', 'NY'])('recognizes US jurisdiction %s', async code => {
  const { snapshot, curator } = await fixture()
  const result = buildJurisdiction({ ...snapshot, plates: [{ ...snapshot.plates[0], state: code }] }, curator, source.imageUrl, code)!
  expect(result.region).toBe('US')
  expect(result.name).not.toBe(code)
})

test('unknown jurisdictions fall back to their code and sort by display name', async () => {
  const { snapshot, curator } = await fixture()
  const plates = ['ZZ', 'PR', 'CA', 'DC', 'AB'].map((state, index) => ({ ...snapshot.plates[0], id: String(index), state }))
  expect(buildDashboard({ ...snapshot, plates }, curator, source.imageUrl).jurisdictions.map(({ code, name, region }) => ({ code, name, region }))).toEqual([
    { code: 'AB', name: 'AB', region: 'other' },
    { code: 'CA', name: 'California', region: 'US' },
    { code: 'DC', name: 'District of Columbia', region: 'US' },
    { code: 'PR', name: 'Puerto Rico', region: 'US' },
    { code: 'ZZ', name: 'ZZ', region: 'other' },
  ])
})
