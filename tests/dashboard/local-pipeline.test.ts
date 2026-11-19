import { afterEach, expect, test, vi } from 'vitest'
import { planTagRun } from '../../components/dashboard/pipeline-runs/local-pipeline'
import { localPipelineReason } from '../../lib/local-pipeline'

afterEach(() => vi.unstubAllEnvs())

const plates = [
  {
    id: 'MD.one',
    state: 'MD',
    displayName: 'One',
    revision: '1',
    tags: ['a', 'b', 'c'],
  },
  {
    id: 'NY.two',
    state: 'NY',
    displayName: 'Two',
    revision: '2',
    tags: ['a', 'b'],
  },
  {
    id: 'NJ.three',
    state: 'NJ',
    displayName: 'Three',
    revision: '3',
    tags: [],
  },
]

test('filters across states before limiting without changing the input', () => {
  expect(planTagRun(plates, true, 1)).toEqual([plates[1]])
  expect(planTagRun(plates, false, 2)).toEqual(plates.slice(0, 2))
  expect(plates).toHaveLength(3)
  expect(plates[0].tags).toHaveLength(3)
})

test.each([0, -1, 26, 1.5, NaN, Infinity])(
  'invalid limit %s cannot plan jobs',
  (limit) => {
    expect(planTagRun(plates, false, limit)).toEqual([])
  }
)

test.each([undefined, '0', 'true', '1'])(
  'disabled reasons require the exact local opt-in %s',
  (flag) => {
    vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', flag)
    expect(localPipelineReason('No implementation')).toBe(
      flag === '1' ? 'No implementation' : 'Coming soon'
    )
  }
)
