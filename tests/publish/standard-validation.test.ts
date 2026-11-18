import { expect, test } from 'vitest'
import { validateSnapshot } from '../../lib/publish/validation'
const plates = ['one', 'two'].map((id, index) => ({
  id,
  state: 'CA',
  slug: id,
  displayName: id,
  image: '',
  tags: [],
  templateRole: 'template' as const,
  isStandard: index === 1,
}))
const baseline = { version: 1, plates }
test('only touched state orders require the Standard first', () => {
  const next = { version: 2, plates }
  expect(validateSnapshot(baseline, next)).toEqual([])
  expect(
    validateSnapshot(baseline, next, new Set(), { CA: ['one', 'two'] })
  ).toContain('Standard must be the first Template in state: CA')
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
