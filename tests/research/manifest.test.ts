import { expect, test } from 'vitest'
import { freezeResearchInputs, researchRunOptions } from '../../worker/research-benchmark'

test('freezing inputs refuses missing corpus plates rather than silently shrinking the comparison', () => {
  expect(() => freezeResearchInputs({ version: 14, plates: [] }, [{ plateId: 'AZ.arizona_highways', split: 'held-out' }])).toThrow('Missing corpus plate')
})

test('benchmark defaults validate configuration without enabling external requests', () => {
  expect(researchRunOptions([])).toMatchObject({ run: false })
  expect(() => researchRunOptions(['--run'])).toThrow('positive --budget-usd')
  expect(() => researchRunOptions(['--run', '--budget-usd', '0'])).toThrow('positive --budget-usd')
  expect(researchRunOptions(['--run', '--budget-usd', '2'])).toMatchObject({ run: true, budgetUsd: 2 })
})
