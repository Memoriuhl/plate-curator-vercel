import { expect, test } from 'vitest'
import { validateSnapshot } from '../../lib/publish/validation'
import type { Plate, Snapshot } from '../../lib/catalog/types'

const plate: Plate = { id: 'AK.one', state: 'AK', slug: 'one', displayName: 'One', tags: [], image: '' }
const baseline: Snapshot = { version: 1, plates: [plate] }
const candidate = (fields: Record<string, unknown>) => ({ version: 2, plates: [{ ...plate, ...fields }] })

test.each([
  { funFacts: [{ text: 'Uncited' }] },
  { funFacts: [{ text: '', sourceUrl: 'https://example.org' }] },
  { funFacts: [{ text: 'Fact', sourceUrl: 'javascript:alert(1)' }] },
  { funFacts: Array.from({ length: 5 }, () => ({ text: 'Fact', sourceUrl: 'https://example.org' })) },
  { readMore: Array.from({ length: 9 }, () => ({ title: 'Reference', site: 'Example', url: 'https://example.org' })) },
  { readMore: [{ title: 'Reference', site: 'Example', url: 'file:///secret' }] },
  { firstIssuedYear: 1799 }, { firstIssuedYear: 2101 }, { firstIssuedYear: 1976.5 },
  { sourceUrl: 'javascript:alert(1)' }, { wikiUrl: '/relative' },
])('rejects changed malformed story fields without depending on the local flag: %j', fields => {
  expect(validateSnapshot(baseline, candidate(fields)).length).toBeGreaterThan(0)
})

test('accepts bounded sourced story fields including existing http links', () => {
  expect(validateSnapshot(baseline, candidate({ firstIssuedYear: 1976, funFacts: [{ text: 'Fact', sourceUrl: 'http://example.org/fact' }], sourceUrl: 'http://example.org/source', wikiUrl: 'https://en.wikipedia.org/wiki/Plate', readMore: [{ title: 'Reference', site: '', url: 'http://example.org' }] }))).toEqual([])
})

test('grandfathers untouched existing values even when unrelated tags change', () => {
  const legacy = { ...plate, funFacts: [{ text: 'Old uncited fact' }], firstIssuedYear: 1750, sourceUrl: 'legacy-source' } as unknown as Plate
  const previous = { version: 1, plates: [legacy] }
  expect(validateSnapshot(previous, { version: 2, plates: [legacy] })).toEqual([])
  expect(validateSnapshot(previous, { version: 2, plates: [{ ...legacy, tags: ['updated'] }] })).toEqual([])
  expect(validateSnapshot(previous, { version: 2, plates: [{ ...legacy, funFacts: [{ text: 'Changed uncited fact' }] }] }).length).toBeGreaterThan(0)
})
