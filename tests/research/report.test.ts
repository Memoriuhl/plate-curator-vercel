import { expect, test } from 'vitest'
import { alignResearchArtifacts } from '../../worker/research-artifact'
import { summarizeResearch, researchArtifactRow } from '../../worker/research-report'

test('failed runs stay in the denominator and unmeasured costs remain explicit', () => {
 const result = summarizeResearch([{ durationMs: 20, description: true, facts: 4, links: 2, status: 'ok', usd: 0.02, missingCost: false }, { durationMs: 10, description: false, facts: 0, links: 0, status: 'failed', usd: null, missingCost: true }])
 expect(result).toMatchObject({ plates: 2, descriptions: 1, facts: 4, failures: 1, knownUsd: 0.02, missingCostPlates: 1, acceptedPlates: null, costPerAcceptedPlate: null })
})

test('missing outputs stay in the manifest denominator without inventing zero-duration runs', () => {
 const input = { plateId: 'AZ.one', displayName: 'One', state: 'AZ', inputRevision: 'r1', baselineVersion: 16 }
 const rows = alignResearchArtifacts([input, { ...input, plateId: 'AZ.two' }, { ...input, plateId: 'AZ.three' }], [{ input, result: null, error: 'failed', durationMs: 100 }])
 expect(summarizeResearch(rows.map(researchArtifactRow))).toMatchObject({ plates: 3, failures: 3, statuses: { failed: 1, unrun: 2 }, p50Ms: 100, p95Ms: 100 })
})
