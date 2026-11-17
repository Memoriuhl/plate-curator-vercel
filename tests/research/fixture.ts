import { createMemoryResearchStore } from '../../lib/research/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { startResearch, type ResearchDeps } from '../../lib/research/jobs'
import { emptyResearchDraft, type ResearchJob, type ResearchResult } from '../../lib/research/types'

export function researchFixture() {
  let now = 1000
  let sequence = 0
  let active = true
  const plate = { id: 'AZ.one', state: 'AZ', slug: 'one', displayName: 'Wildlife', tags: [], image: 'one.webp' }
  const owner = { uid: 'owner', role: 'owner' as const, name: 'Owner' }
  const review = { store: createMemoryStore([{ id: 'batch', name: 'Research', createdBy: 'owner', createdAt: 'now', state: 'open', revision: 0, baselineVersion: 14, plateIds: [plate.id], approval: null }]), baseline: async () => plate, baselineAtVersion: async () => plate, stateBaseline: async () => [plate], now: () => 'now' }
  const store = createMemoryResearchStore()
  const deps: ResearchDeps = { store, review, active: async () => active, now: () => now, id: () => `claim-${++sequence}`, hostedEnabled: true, legacyRevision: 'legacy-r1' }
  const start = (requestKey = 'request', executor: 'desktop' | 'eve' = 'desktop', replaceJobId?: string) => startResearch(deps, owner, { batchId: 'batch', plateId: plate.id, executor, requestKey, ...(replaceJobId ? { replaceJobId } : {}) })
  const result = (job: ResearchJob): ResearchResult => ({ input: job.input, draft: emptyResearchDraft(), sources: [], rejected: [], provenance: { executor: 'desktop', model: 'gemma4:12b', promptVersion: 'story-v2', codeRevision: 'legacy-r1' }, attempts: [], durationMs: 1, status: 'no_sources', cost: { usd: null, missing: 1 }, counters: {}, cache: 'unknown' })
  return { deps, store, review, owner, plate, start, result, advance: (ms: number) => { now += ms }, remove: () => { active = false } }
}

