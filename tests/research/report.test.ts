import { expect, test } from 'vitest'
import { summarizeResearch } from '../../worker/research-report'

test('failed runs stay in the denominator and unmeasured costs remain explicit', () => {
 const result = summarizeResearch([{ durationMs: 20, description: true, facts: 4, links: 2, status: 'ok', usd: 0.02, missingCost: false }, { durationMs: 10, description: false, facts: 0, links: 0, status: 'failed', usd: null, missingCost: true }])
 expect(result).toMatchObject({ plates: 2, descriptions: 1, facts: 4, failures: 1, knownUsd: 0.02, missingCostPlates: 1, acceptedPlates: null, costPerAcceptedPlate: null })
})
