import { expect, test } from 'vitest'
import { validateSnapshot } from '../../lib/publish/validation'
const plates = ['one', 'two', 'three'].map((id, index) => ({
  id,
  state: 'CA',
  slug: id,
  displayName: id,
  image: '',
  tags: [],
  sortOrder: index,
  templateRole: 'template' as const,
  isStandard: index === 1,
}))
const baseline = { version: 1, plates }
test('publishing a reorder below the first plate preserves the existing Standard mismatch', () => {
  const next = { version: 2, plates }
  expect(validateSnapshot(baseline, next)).toEqual([])
  expect(
    validateSnapshot(baseline, next, new Set(), { CA: ['one', 'three', 'two'] })
  ).toEqual([])
  expect(
    validateSnapshot(baseline, next, new Set(), { CA: ['two', 'one'] })
  ).toEqual([])
  expect(
    validateSnapshot(
      baseline,
      { ...next, plates: plates.map((p) => ({ ...p, isStandard: false })) },
      new Set(),
      { CA: ['two', 'one'] }
    )
  ).toContain('Standard must be the first Template in state: CA')
})

test('publishing refuses a newly demoted Standard even when the first plate is unchanged', () => {
  const next = {
    version: 2,
    plates: plates.map((plate) =>
      plate.isStandard ? { ...plate, templateRole: 'variant' } : plate
    ),
  }
  expect(
    validateSnapshot(baseline, next, new Set(), { CA: ['one', 'three', 'two'] })
  ).toContain('Standard must be the first Template in state: CA')
})
