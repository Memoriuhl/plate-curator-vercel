import { expect, test } from 'vitest'
import {
  limits,
  parseBatchInput,
  parseEditableFields,
} from '../../lib/review/fields'

test('accepts every editable field with valid values', () => {
  const fields = {
    tags: ['bear', 'blue'],
    templateFamily: 'ak-gold',
    templateRole: 'variant',
    variantOfPlateId: 'AK.standard_gold',
    isStandard: false,
  }
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

test('batch input needs a bounded name and accepts a state-sized list of distinct Plate IDs', () => {
  expect(
    parseBatchInput({ name: ' AK review ', plateIds: ['AK.a', 'AK.b'] })
  ).toEqual({ name: 'AK review', plateIds: ['AK.a', 'AK.b'] })
  expect(
    parseBatchInput({ name: 'x'.repeat(121), plateIds: ['AK.a'] })
  ).toBeNull()
  expect(parseBatchInput({ name: 'ok', plateIds: [] })).toBeNull()
  const fullState = Array.from({ length: limits.plates }, (_, i) => `MD.${i}`)
  expect(parseBatchInput({ name: 'Maryland', plateIds: fullState })).toEqual({
    name: 'Maryland',
    plateIds: fullState,
  })
  expect(
    parseBatchInput({ name: 'ok', plateIds: [...fullState, 'MD.extra'] })
  ).toBeNull()
  expect(parseBatchInput({ name: 'ok', plateIds: [42] })).toBeNull()
})

test('description accepts trimmed text up to 2000 characters or null to clear', () => {
  expect(parseEditableFields({ description: ' New description ' })).toEqual({
    description: 'New description',
  })
  expect(parseEditableFields({ description: 'x'.repeat(2000) })).toEqual({
    description: 'x'.repeat(2000),
  })
  expect(parseEditableFields({ description: null })).toEqual({
    description: null,
  })
  for (const description of ['', '   ', 'x'.repeat(2001), 1, false, []]) {
    expect(parseEditableFields({ description })).toBeNull()
  }
})

test('variant link accepts null to clear and a bounded string to set', () => {
  const detached = {
    templateRole: 'template',
    variantOfPlateId: null,
    templateFamily: 'AK.one',
  }
  expect(parseEditableFields(detached)).toEqual(detached)
  expect(parseEditableFields({ variantOfPlateId: ' AK.parent ' })).toEqual({
    variantOfPlateId: 'AK.parent',
  })
  for (const variantOfPlateId of ['', ' ', 1, false, [], {}, 'x'.repeat(121)]) {
    expect(parseEditableFields({ variantOfPlateId })).toBeNull()
  }
  expect(parseEditableFields({ templateFamily: null })).toBeNull()
})
