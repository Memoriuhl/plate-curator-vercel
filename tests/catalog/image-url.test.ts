import { expect, test } from 'vitest'
import { plateImageUrl } from '../../lib/catalog/image-url'
import { fixtureSource } from '../../lib/catalog/fixture-source'
import type { Plate } from '../../lib/catalog/types'

/** Build the base plate for image path and override tests with optional field changes. */
const plate = (fields: Partial<Plate>): Plate => ({
  id: 'AK.standard_gold',
  state: 'AK',
  slug: 'standard_gold',
  displayName: 'Standard Gold',
  tags: [],
  image: 'AK/standard_gold.webp',
  ...fields,
})
const base = 'https://store.public.blob.vercel-storage.com'

test('builds the image url from the plate image path and the base', () => {
  expect(plateImageUrl(plate({}), base)).toBe(
    `${base}/plates/AK/standard_gold.webp`
  )
  expect(plateImageUrl(plate({}), `${base}/`)).toBe(
    `${base}/plates/AK/standard_gold.webp`
  )
})

test('an explicit imageUrl wins over the derived one', () => {
  expect(
    plateImageUrl(plate({ imageUrl: 'https://example.com/p.webp' }), base)
  ).toBe('https://example.com/p.webp')
})

test('is null without a base or a usable image path', () => {
  expect(plateImageUrl(plate({}), null)).toBeNull()
  for (const image of [
    '',
    '../secret.webp',
    'AK/../../x.webp',
    '/AK/a.webp',
    'AK/a.png',
    'AK/a b.webp',
  ]) {
    expect(plateImageUrl(plate({ image }), base)).toBeNull()
  }
})

test('the fixture source derives image urls when given a base', () => {
  expect(fixtureSource(base).imageUrl(plate({}))).toBe(
    `${base}/plates/AK/standard_gold.webp`
  )
  expect(fixtureSource().imageUrl(plate({}))).toBeNull()
})
