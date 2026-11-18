import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import type { Plate } from '../../lib/catalog/types'
import { plateRevision } from '../../lib/review/revision'

const plate: Plate = {
  id: 'one',
  state: 'CA',
  slug: 'one',
  displayName: 'One',
  tags: [],
  image: 'one.png',
}

test('key order does not change the revision', () => {
  expect(
    plateRevision({ ...plate, extra: { b: 2, a: [{ y: 2, x: 1 }] } })
  ).toBe(plateRevision({ extra: { a: [{ x: 1, y: 2 }], b: 2 }, ...plate }))
})

test('undefined fields are ignored', () => {
  expect(
    plateRevision({
      ...plate,
      templateFamily: undefined,
      extra: { value: 1, omitted: undefined },
    })
  ).toBe(plateRevision({ ...plate, extra: { value: 1 } }))
})

test('revision is 20 hex chars', () => {
  expect(plateRevision(plate)).toMatch(/^[a-f0-9]{20}$/)
})

test('revision hashes sorted JSON and preserves array order', () => {
  const sortedJson =
    '{"displayName":"One","id":"one","image":"one.png","slug":"one","state":"CA","tags":[]}'
  expect(plateRevision(plate)).toBe(
    createHash('sha256').update(sortedJson).digest('hex').slice(0, 20)
  )
  expect(plateRevision({ ...plate, tags: ['a', 'b'] })).not.toBe(
    plateRevision({ ...plate, tags: ['b', 'a'] })
  )
})
