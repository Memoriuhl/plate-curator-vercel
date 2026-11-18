import { createMemoryResearchStore } from '../../lib/research/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { startResearch, type ResearchDeps } from '../../lib/research/jobs'
import {
  emptyResearchDraft,
  type ResearchJob,
  type ResearchResult,
} from '../../lib/research/types'

/**
 * Build isolated research and review stores with controllable time, IDs and owner
 * access.
 */
export function researchFixture() {
  let now = 1000
  let sequence = 0
  let active = true
  const plate = {
    id: 'AZ.one',
    state: 'AZ',
    slug: 'one',
    displayName: 'Wildlife',
    tags: [],
    image: 'one.webp',
    sourceUrl: 'https://example.com/image',
    funFacts: [
      { text: 'Existing curator fact', sourceUrl: 'https://example.com/old' },
    ],
  }
  const owner = { uid: 'owner', role: 'owner' as const, name: 'Owner' }
  const review = {
    store: createMemoryStore([
      {
        id: 'batch',
        name: 'Research',
        createdBy: 'owner',
        createdAt: 'now',
        state: 'open',
        revision: 0,
        baselineVersion: 14,
        plateIds: [plate.id],
        approval: null,
      },
    ]),
    /** Supply the test plate as the catalog baseline. */ baseline: async () =>
      plate,
    /** Supply the test plate as the catalog baseline. */ baselineAtVersion:
      async () => plate,
    /** Return the fixture state order used by the review or queue operation. */ stateBaseline:
      async () => [plate],
    /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () =>
      'now',
  }
  const store = createMemoryResearchStore()
  const deps: ResearchDeps = {
    store,
    review,
    /** Expose whether the test has left the research actor's membership active. */ active:
      async () => active,
    /** Read the controlled test clock so state and lease timestamps advance deterministically. */ now: () =>
      now,
    /** Issue deterministic IDs in allocation order so the test can address each generated record. */ id: () =>
      `claim-${++sequence}`,
    hostedEnabled: true,
    legacyRevision: 'legacy-r1',
  }
  /**
   * Start the fixture plate's research job with the requested model and optional
   * replacement.
   */
  const start = (
    requestKey = 'request',
    executor: 'desktop' | 'eve' = 'desktop',
    replaceJobId?: string
  ) =>
    startResearch(deps, owner, {
      batchId: 'batch',
      plateId: plate.id,
      executor,
      requestKey,
      ...(replaceJobId ? { replaceJobId } : {}),
    })
  /**
   * Build an attributed result for the exact job input using deterministic research
   * metrics.
   */
  const result = (job: ResearchJob): ResearchResult => ({
    input: job.input,
    draft: emptyResearchDraft(),
    sources: [],
    rejected: [],
    provenance: {
      executor: 'desktop',
      model: 'gemma4:12b',
      promptVersion: 'story-v2',
      codeRevision: 'legacy-r1',
    },
    attempts: [],
    durationMs: 1,
    status: 'no_sources',
    cost: { usd: null, missing: 1 },
    counters: {},
    cache: 'unknown',
  })
  return {
    deps,
    store,
    review,
    owner,
    plate,
    start,
    result,
    /** Move the test clock forward so deadlines can be reached without waiting. */ advance:
      (ms: number) => {
        now += ms
      },
    /** Revoke the actor's active status so later research operations recheck access. */ remove:
      () => {
        active = false
      },
  }
}
