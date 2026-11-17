import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { emptyResearchDraft, type ResearchInput, type ResearchResult } from '../lib/research/types'

type LegacySource = { id: string; kind: string; title: string; url: string; text: string }
export type LegacyOutcome = {
  id: string; sources: LegacySource[]; attempts: unknown[]; model: string | null; promptVersion: string
  status: 'ok' | 'partial' | 'no_sources' | 'failed'
  draft: { description: string | null; descriptionSource: LegacySource | null; funFacts: { text: string; sourceUrl: string }[]; firstIssuedYear: number | null }
  readMore: { title: string; url: string }[]
}
type LegacyModule = { storyForPlate(plate: { id: string; displayName: string; state: string }, options: { model: string }): Promise<LegacyOutcome> }
type LegacyDeps = { revision(root: string): Promise<string>; load(root: string): Promise<LegacyModule>; now(): number }

const defaults: LegacyDeps = {
  async revision(root) { return (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim() },
  async load(root) { return import(pathToFileURL(resolve(root, 'scripts/lib/story/stage.ts')).href) as Promise<LegacyModule> },
  now: Date.now,
}

export async function runLegacyResearch(input: ResearchInput, options: { legacyRoot: string; model: string; expectedRevision: string }, deps: LegacyDeps = defaults): Promise<ResearchResult> {
  const revision = await deps.revision(options.legacyRoot)
  if (revision !== options.expectedRevision) throw new Error('Legacy revision differs from the frozen baseline')
  const started = deps.now()
  const legacy = await deps.load(options.legacyRoot)
  const outcome = await legacy.storyForPlate({ id: input.plateId, displayName: input.displayName, state: input.state }, { model: options.model })
  if (outcome.id !== input.plateId) throw new Error('Legacy result identity differs from the request')
  const sources = outcome.sources.map(source => ({ ...source, kind: source.kind === 'wikipedia' ? 'wikipedia' as const : 'web' as const, fetchedAt: new Date(started).toISOString(), contentHash: createHash('sha256').update(source.text).digest('hex') }))
  const result: ResearchResult = {
    input, sources, draft: emptyResearchDraft(), rejected: [], attempts: outcome.attempts,
    provenance: { executor: 'desktop', model: outcome.model ?? options.model, promptVersion: outcome.promptVersion, codeRevision: revision },
    durationMs: Math.max(0, deps.now() - started), status: outcome.status,
    cost: { usd: null, missing: 1 }, counters: {}, cache: 'unknown',
  }
  const descriptionSource = sources.find(source => source.id === outcome.draft.descriptionSource?.id)
  if (descriptionSource && outcome.draft.description) {
    result.draft.description = outcome.draft.description
    result.draft.descriptionSources = [descriptionSource.id]
  }
  for (const fact of outcome.draft.funFacts) {
    const source = sources.find(source => source.url === fact.sourceUrl)
    if (source) result.draft.funFacts.push({ text: fact.text, sourceId: source.id })
    else result.rejected.push({ field: 'funFacts', reason: 'source_not_fetched' })
  }
  result.draft.readMore = [...new Set(outcome.readMore.flatMap(link => sources.find(source => source.url === link.url)?.id ?? []))]
  result.draft.wikiSource = sources.find(source => source.kind === 'wikipedia')?.id ?? null
  return result
}
