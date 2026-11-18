import { expect, test } from 'vitest'
import { routeRegion, summarizeRegions } from '@/components/app/regions'

const jurisdictions = [
  { code: 'AK', region: 'US' },
  { code: 'MD', region: 'US' },
  { code: 'ON', region: 'CA' },
  { code: 'BC', region: 'CA' },
  { code: 'CMX', region: 'MX' },
  { code: 'FR', region: 'EU' },
]

test('regions retain the first jurisdiction in summary order and count availability', () => {
  expect(summarizeRegions(jurisdictions)).toEqual([
    { region: 'US', firstCode: 'AK', count: 2 },
    { region: 'CA', firstCode: 'ON', count: 2 },
    { region: 'MX', firstCode: 'CMX', count: 1 },
    { region: 'EU', firstCode: 'FR', count: 1 },
  ])
  expect(summarizeRegions([])).toEqual([])
})

test.each([
  [{ code: 'ON' }, '/states/ON', 'CA'],
  [{ code: 'FR' }, '/states/FR', 'EU'],
  [{ id: 'CMX.army' }, '/plates/CMX.army', 'MX'],
  [{ id: 'AK.army' }, '/plates/AK.army', 'US'],
  [{ id: 'ON.army' }, '/review/ON.army', 'US'],
  [{ code: 'unknown' }, '/states/unknown', 'US'],
  [{}, '/', 'US'],
])(
  'region follows the jurisdiction URL with a US default: %j',
  (params, pathname, expected) => {
    expect(routeRegion(params, pathname, jurisdictions)).toBe(expected)
  }
)
