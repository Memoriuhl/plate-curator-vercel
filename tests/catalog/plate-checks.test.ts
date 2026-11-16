import { expect, test } from 'vitest'
import { isComplete, plateChecks } from '../../lib/catalog/plate-checks'
import type { Plate } from '../../lib/catalog/types'

const plate: Plate = {
  id: 'AK.one', state: 'AK', slug: 'one', displayName: 'One', image: 'one.webp',
  tags: ['one', 'two', 'three'], description: 'A sufficiently detailed description of this plate.',
  templateFamily: 'family', templateRole: 'template', sourceUrl: 'https://example.com',
}

test('client checks use the supplied image URL and completeness excludes optional facts and rarity', () => {
  const checks = plateChecks(plate, '/plate.webp')
  expect(checks.image).toEqual({ status: 'good', value: '/plate.webp' })
  expect(checks.funFacts.status).toBe('missing')
  expect(checks.rarity.status).toBe('missing')
  expect(isComplete(checks)).toBe(true)
  expect(isComplete(plateChecks(plate, null))).toBe(false)
})
