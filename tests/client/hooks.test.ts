import { expect, test } from 'vitest'
import { batchesKey } from '../../lib/client/hooks'

test('batch cache keys distinguish mine and compose it with states', () => {
  expect(batchesKey()).toBe('/api/batches')
  expect(batchesKey([], { mine: false })).toBe('/api/batches')
  expect(batchesKey(undefined, { mine: true })).toBe('/api/batches?mine=1')
  expect(batchesKey(['open', 'submitted'])).toBe('/api/batches?state=open,submitted')
  expect(batchesKey(['open'], { mine: true })).toBe('/api/batches?state=open&mine=1')
})
