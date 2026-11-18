import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { ResearchInput, EvidenceSource } from '../../lib/research/types'
import { expect, test, vi } from 'vitest'
import { alignResearchArtifacts, loadResearchArtifacts } from '../../worker/research-artifact'
import { executeResearchBenchmark } from '../../worker/research-benchmark'
import { researchFixture } from './fixture'

const input = { plateId: 'AZ.one', displayName: 'Wildlife', state: 'AZ', inputRevision: 'r1', baselineVersion: 16 }

test('reports align with the entire manifest and reject duplicate, unexpected or mismatched inputs', () => {
 const saved = { input, result: null }
 expect(alignResearchArtifacts([input, { ...input, plateId: 'AZ.two' }], [saved])).toMatchObject([saved, { input: { plateId: 'AZ.two' }, error: 'unrun_or_interrupted' }])
 expect(() => alignResearchArtifacts([input], [saved, saved])).toThrow('Duplicate')
 expect(() => alignResearchArtifacts([input], [{ ...saved, input: { ...input, plateId: 'AZ.other' } }])).toThrow('Unexpected')
 expect(() => alignResearchArtifacts([input], [{ ...saved, input: { ...input, inputRevision: 'old' } }])).toThrow('identity')
})

test('a clean baseline output feeds identical-evidence control and report loading without an external aggregate', async () => {
 await mkdir('eval-results', { recursive: true })
 const directory = await mkdtemp('eval-results/research-contract-')
 vi.stubEnv('RESEARCH_ENABLE_MODEL_CALLS', 'true')
 vi.stubEnv('RESEARCH_BUDGET_USD', '2')
 try {
  const manifest = `${directory}/manifest.json`
  await writeFile(manifest, JSON.stringify({ inputs: [input] }))
  const f = researchFixture()
  const source = { id: 'S1', kind: 'web' as const, title: 'Wildlife', url: 'https://example.com/wildlife', fetchedAt: '2026-11-17T00:00:00Z', contentHash: 'hash', text: 'Captured passage used by the unchanged baseline.' }
  const result = { ...f.result({ input } as never), input, sources: [source] }
  await executeResearchBenchmark({ run: true, executor: 'desktop', budgetUsd: 2, manifest, output: `${directory}/desktop` }, { desktop: async () => ({ result }) })
  const synthesize = vi.fn(async (receivedInput: ResearchInput, receivedSources: EvidenceSource[]) => { expect(receivedInput).toEqual(input); expect(receivedSources).toEqual([source]); return { draft: result.draft, rejected: [], durationMs: 1, cost: { usd: 0, missing: 0 } } })
  await executeResearchBenchmark({ run: true, executor: 'control', budgetUsd: 2, manifest, baseline: `${directory}/desktop`, output: `${directory}/control` }, { control: synthesize })
  expect(synthesize.mock.calls[0][1]).toEqual([source])
  const baseline = await loadResearchArtifacts(`${directory}/desktop`, [input])
  const control = await loadResearchArtifacts(`${directory}/control`, [input])
  expect(baseline[0].result?.sources).toEqual(control[0].result?.sources)
  expect(control[0]).toMatchObject({ schemaVersion: 1, result: { input, cost: { usd: 0 } } })
  expect(JSON.parse(await readFile(`${directory}/desktop/AZ.one.json`, 'utf8'))).toHaveProperty('schemaVersion', 1)
 } finally { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) }
})
