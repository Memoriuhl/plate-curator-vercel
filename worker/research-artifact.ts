import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ResearchInput, ResearchResult, ResearchDraft, EvidenceSource } from '../lib/research/types'
import type { LegacyOutcome } from './research-legacy'

export type ResearchArtifact = {
  schemaVersion?: number; input: ResearchInput & { split?: string }; result?: ResearchResult | null; raw?: LegacyOutcome
  durationMs?: number; draft?: ResearchDraft; sources?: EvidenceSource[]; cost?: { usd: number | null; missing: number }
  settled?: { costUsd?: number }; error?: string | null; skipped?: string
}
const identity = (input: ResearchInput) => JSON.stringify([input.plateId, input.displayName, input.state, input.inputRevision, input.baselineVersion])

export function alignResearchArtifacts(inputs: ResearchInput[], artifacts: ResearchArtifact[]): ResearchArtifact[] {
  const expected = new Map(inputs.map(input => [input.plateId, input]))
  if (expected.size !== inputs.length) throw new Error('Duplicate manifest identity')
  const saved = new Map<string, ResearchArtifact>()
  for (const artifact of artifacts) {
    const input = artifact.input && expected.get(artifact.input.plateId)
    if (!input) throw new Error('Unexpected research artifact')
    if (saved.has(input.plateId)) throw new Error('Duplicate research artifact')
    if (identity(input) !== identity(artifact.input) || artifact.result && identity(input) !== identity(artifact.result.input) || artifact.raw && artifact.raw.id !== input.plateId) throw new Error('Research artifact identity mismatch')
    saved.set(input.plateId, artifact)
  }
  return inputs.map(input => saved.get(input.plateId) ?? { schemaVersion: 1, input, result: null, error: 'unrun_or_interrupted' })
}

export async function loadResearchArtifacts(path: string, inputs: ResearchInput[]) {
  let artifacts: ResearchArtifact[]
  try {
    const names = await readdir(path)
    artifacts = await Promise.all(names.filter(name => name.endsWith('.json') && !name.endsWith('.receipt.json') && !['configuration.json', 'manifest.json', 'snapshot.json', 'desktop-raw.json'].includes(name)).map(async name => JSON.parse(await readFile(resolve(path, name), 'utf8')) as ResearchArtifact))
    if (!artifacts.length && names.includes('desktop-raw.json')) artifacts = JSON.parse(await readFile(resolve(path, 'desktop-raw.json'), 'utf8')) as ResearchArtifact[]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') artifacts = JSON.parse(await readFile(path, 'utf8')) as ResearchArtifact[]
    else if ((error as NodeJS.ErrnoException).code === 'ENOENT') artifacts = []
    else throw error
  }
  return alignResearchArtifacts(inputs, artifacts)
}

export function capturedSources(artifact: ResearchArtifact): EvidenceSource[] {
  if (artifact.result) return artifact.result.sources
  if (artifact.sources) return artifact.sources
  return (artifact.raw?.sources ?? []).map(source => ({ ...source, kind: source.kind === 'wikipedia' ? 'wikipedia' as const : 'web' as const, fetchedAt: new Date().toISOString(), contentHash: createHash('sha256').update(source.text).digest('hex') }))
}
