import { afterEach, expect, test, vi } from 'vitest'
import { editableKeys, parseEditableFields } from '../../lib/review/fields'
import { validateSnapshot } from '../../lib/publish/validation'
import { changedStoryFields } from '../../lib/review/story'

afterEach(() => vi.unstubAllEnvs())

test('color fields extend the shared edit list and require the local flag', () => {
  const fields = { colorDetail: 'white', lineageColor: 'white' }
  expect(editableKeys).toContain('colorDetail')
  expect(editableKeys).toContain('lineageColor')
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  expect(parseEditableFields(fields)).toBeNull()
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  expect(parseEditableFields(fields)).toEqual(fields)
  expect(parseEditableFields({ colorDetail: 'x'.repeat(121) })).toBeNull()
  expect(parseEditableFields({ lineageColor: 1 })).toBeNull()
  expect(parseEditableFields({ colorDetail: null, lineageColor: null })).toEqual({ colorDetail: null, lineageColor: null })
})

test('publication validates changed colors, leaving legacy values alone', () => {
  const plate = { id: 'MD.one', state: 'MD', slug: 'one', displayName: 'One', image: '', tags: [], colorDetail: 'white' }
  const baseline = { version: 1, plates: [plate] }
  expect(validateSnapshot(baseline, { version: 2, plates: [{ ...plate, colorDetail: 1 }] })).toContain('Plate 0 has invalid colorDetail')
  expect(validateSnapshot(baseline, { version: 2, plates: [{ ...plate, colorDetail: 'gold', lineageColor: 'yellow' }] })).toEqual([])
})

test('a story save never takes an image provenance key from its input', () => {
  const before = { wikiUrl: 'https://example.org/wiki', sourceUrl: 'https://example.org/image' }
  const after = { ...before, sourceUrl: 'https://example.org/wrong-image', wikiUrl: 'http://example.org/reference' }
  expect(changedStoryFields(before, after)).toEqual({ wikiUrl: 'http://example.org/reference' })
})
