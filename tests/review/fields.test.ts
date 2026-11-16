import { expect, test } from 'vitest'
import { parseBatchInput, parseEditableFields } from '../../lib/review/fields'

test('accepts every editable field with valid values', () => {
  const fields = { tags: ['bear', 'blue'], templateFamily: 'ak-gold', templateRole: 'variant', variantOfPlateId: 'AK.standard_gold', isStandard: false }
  expect(parseEditableFields(fields)).toEqual(fields)
})

test('trims tags and rejects blank ones', () => {
  expect(parseEditableFields({ tags: [' bear '] })).toEqual({ tags: ['bear'] })
  expect(parseEditableFields({ tags: ['  '] })).toBeNull()
})

test.each([
  ['an unknown key', { color: 'red' }],
  ['no fields', {}],
  ['a non-array tags', { tags: 'bear' }],
  ['a non-string tag', { tags: [1] }],
  ['too many tags', { tags: Array.from({ length: 51 }, (_, i) => `t${i}`) }],
  ['an overlong tag', { tags: ['x'.repeat(61)] }],
  ['an unknown templateRole', { templateRole: 'parent' }],
  ['a non-boolean isStandard', { isStandard: 'yes' }],
  ['an overlong templateFamily', { templateFamily: 'x'.repeat(121) }],
  ['an array', [] as unknown],
  ['null', null],
])('rejects %s', (_label, input) => {
  expect(parseEditableFields(input)).toBeNull()
})

test('batch input needs a bounded name and 1 to 50 distinct plate ids', () => {
  expect(parseBatchInput({ name: ' AK review ', plateIds: ['AK.a', 'AK.b'] })).toEqual({ name: 'AK review', plateIds: ['AK.a', 'AK.b'] })
  expect(parseBatchInput({ name: 'x'.repeat(121), plateIds: ['AK.a'] })).toBeNull()
  expect(parseBatchInput({ name: 'ok', plateIds: [] })).toBeNull()
  expect(parseBatchInput({ name: 'ok', plateIds: Array.from({ length: 51 }, (_, i) => `AK.${i}`) })).toBeNull()
  expect(parseBatchInput({ name: 'ok', plateIds: [42] })).toBeNull()
})
