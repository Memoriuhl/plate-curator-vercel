import { describe, expect, it } from 'vitest'
import { overallScore, scoreTags } from '../../lib/eval/score'

describe('tag scoring', () => {
  it.each([
    {
      suggested: [' Blue ', 'blue', ''],
      curated: ['BLUE'],
      precision: 1,
      recall: 1,
      f1: 1,
    },
    { suggested: [], curated: ['blue'], precision: 0, recall: 0, f1: 0 },
    { suggested: ['blue'], curated: [], precision: 0, recall: 1, f1: 0 },
    { suggested: [], curated: [], precision: 1, recall: 1, f1: 1 },
    { suggested: ['red'], curated: ['blue'], precision: 0, recall: 0, f1: 0 },
    {
      suggested: ['blue', 'red'],
      curated: ['blue', 'white'],
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
    },
  ])(
    'scores $suggested against $curated',
    ({ suggested, curated, precision, recall, f1 }) => {
      expect(scoreTags(suggested, curated)).toMatchObject({
        precision,
        recall,
        f1,
      })
    }
  )

  it('aggregates tag counts across Plates rather than averaging plate metrics', () => {
    const result = overallScore([
      scoreTags(['blue'], ['blue']),
      scoreTags([], ['red', 'white', 'green']),
    ])
    expect(result.precision).toBe(1)
    expect(result.recall).toBe(0.25)
    expect(result.f1).toBe(0.4)
  })
})
