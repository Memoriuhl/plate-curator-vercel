import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { plateRevision } from '../../lib/review/draft/revision'
import { claimResearch, reportResearch } from '../../lib/research/jobs'
import { acceptResearch } from '../../lib/research/accept'
import {
  hostedResearchResult,
  submitResearchDraft,
} from '../../lib/research/runtime'
import { researchNeeds, researchOutcome } from '../../lib/research/outcome'
import { createResearchMemoryState } from '../../lib/research/state'
import {
  emptyResearchDraft,
  type EvidenceSource,
  type ResearchDraft,
} from '../../lib/research/types'
import { missingResearchInput } from '../../lib/jobs/queue/queue-engine'
import type { RunAttempt } from '../../lib/jobs/queue/queue-types'
import type { ProjectedPlate } from '../../lib/jobs/queue/queue-projection'
import type { RunStep } from '../../lib/jobs/pipeline/pipeline-plan'
import { validateStory } from '../../worker/pipeline/validate'
import { researchFixture } from './fixture'

const text =
  'The wildlife program began in 1987 and supports habitat protection across Arizona through optional registration fees. Volunteers counted 400 nesting eagles along the Verde River.'
const source: EvidenceSource = {
  id: 'S1',
  kind: 'web',
  url: 'https://example.com/wildlife',
  title: 'Wildlife program',
  text,
  contentHash: createHash('sha256').update(text).digest('hex'),
  fetchedAt: '2026-11-17T00:00:00Z',
}
const description =
  'The wildlife program supports habitat protection across Arizona through optional registration fees.'
const fact = { text: 'The wildlife program began in 1987.', sourceId: 'S1' }
const secondFact = {
  text: 'Volunteers counted 400 nesting eagles along the Verde River.',
  sourceId: 'S1',
}

/** Build a validated draft containing only the named content fields. */
function draft(fields: { description?: boolean; facts?: number }) {
  return {
    ...emptyResearchDraft(),
    ...(fields.description ? { description, descriptionSources: ['S1'] } : {}),
    funFacts: [fact, secondFact].slice(0, fields.facts ?? 0),
  } satisfies ResearchDraft
}

test.each([
  {
    name: 'description-only request with a description',
    requested: ['description'] as const,
    result: draft({ description: true }),
    status: 'ok',
    missing: [],
  },
  {
    name: 'facts-only request with facts',
    requested: ['funFacts'] as const,
    result: draft({ facts: 1 }),
    status: 'ok',
    missing: [],
  },
  {
    name: 'both requested and both returned',
    requested: ['description', 'funFacts'] as const,
    result: draft({ description: true, facts: 2 }),
    status: 'ok',
    missing: [],
  },
  {
    name: 'both requested, only the description returned',
    requested: ['description', 'funFacts'] as const,
    result: draft({ description: true }),
    status: 'partial',
    missing: ['funFacts'],
  },
  {
    name: 'both requested, only facts returned',
    requested: ['description', 'funFacts'] as const,
    result: draft({ facts: 1 }),
    status: 'partial',
    missing: ['description'],
  },
  {
    name: 'facts-only request ignores an absent description',
    requested: ['funFacts'] as const,
    result: draft({}),
    status: 'partial',
    missing: ['funFacts'],
  },
])('judges a result against what was requested: $name', (row) => {
  expect(researchOutcome(row.result, [source], [...row.requested])).toEqual({
    status: row.status,
    missing: row.missing,
  })
})

test('nothing needed is a success, even without sources', () => {
  expect(researchOutcome(emptyResearchDraft(), [], [])).toEqual({
    status: 'ok',
    missing: [],
  })
})

test('a request without captured sources is no_sources', () => {
  expect(researchOutcome(emptyResearchDraft(), [], ['funFacts'])).toEqual({
    status: 'no_sources',
    missing: ['funFacts'],
  })
})

test('an unknown request keeps the original rule and requires both fields', () => {
  expect(researchOutcome(draft({ facts: 1 }), [source], undefined)).toEqual({
    status: 'partial',
    missing: ['description'],
  })
})

test('research needs only the content fields a plate lacks', () => {
  expect(researchNeeds({ description: 'Saved', funFacts: [] })).toEqual([
    'funFacts',
  ])
  expect(
    researchNeeds({
      description: '  ',
      funFacts: [{ text: 'Saved', sourceUrl: 'https://example.com' }],
    })
  ).toEqual(['description'])
  expect(researchNeeds({})).toEqual(['description', 'funFacts'])
  expect(
    researchNeeds({
      description: 'Saved',
      funFacts: [{ text: 'Saved', sourceUrl: 'https://example.com' }],
    })
  ).toEqual([])
})

/** Start, claim and report one desktop research job with the supplied draft. */
async function reported(
  plate: Parameters<typeof researchFixture>[0],
  result: ResearchDraft,
  sources: EvidenceSource[] = [source]
) {
  const f = researchFixture(plate)
  const started = await f.start()
  if (!started.ok) throw Error(started.error)
  const claim = (await claimResearch(f.deps, 'desktop'))!
  const outcome = await reportResearch(f.deps, 'desktop', {
    jobId: claim.job.id,
    claimId: claim.claimId,
    result: { ...f.result(claim.job), sources, draft: result },
  })
  return { f, job: started.value, outcome }
}

test('a plate that already has a description succeeds with facts alone', async () => {
  const { job, outcome } = await reported(
    { description, funFacts: [] },
    draft({ facts: 2 })
  )
  expect(job.input.requested).toEqual(['funFacts'])
  expect(outcome).toMatchObject({
    ok: true,
    value: {
      state: 'completed',
      result: { status: 'ok', missing: [], draft: { description: null } },
    },
  })
})

test('a plate that already has facts succeeds with a description alone', async () => {
  const { job, outcome } = await reported({}, draft({ description: true }))
  expect(job.input.requested).toEqual(['description'])
  expect(outcome).toMatchObject({
    ok: true,
    value: { state: 'completed', result: { status: 'ok', missing: [] } },
  })
})

test('when both were missing, a partial result is saved and the rest stays missing', async () => {
  const { job, outcome } = await reported(
    { funFacts: [] },
    draft({ description: true })
  )
  expect(job.input.requested).toEqual(['description', 'funFacts'])
  expect(outcome).toMatchObject({
    ok: true,
    value: {
      state: 'completed',
      result: {
        status: 'partial',
        missing: ['funFacts'],
        draft: { description },
      },
    },
  })
})

test('a plate that needs nothing is a success even with no sources', async () => {
  const { job, outcome } = await reported(
    {
      description,
      funFacts: [{ text: 'Saved', sourceUrl: 'https://example.com' }],
    },
    emptyResearchDraft(),
    []
  )
  expect(job.input.requested).toEqual([])
  expect(outcome).toMatchObject({
    ok: true,
    value: { state: 'completed', result: { status: 'ok', missing: [] } },
  })
})

test('a hosted result is judged against the requested fields', () => {
  const f = researchFixture({ description, funFacts: [] })
  const input = {
    plateId: f.plate.id,
    displayName: f.plate.displayName,
    state: f.plate.state,
    inputRevision: plateRevision(f.plate),
    baselineVersion: 14,
    requested: ['funFacts' as const],
  }
  expect(
    hostedResearchResult(
      input,
      { draft: draft({ facts: 1 }), sources: [source], rejected: [] },
      { durationMs: 1, counters: {} }
    )
  ).toMatchObject({ status: 'ok', missing: [] })
})

test('the draft submission tool reports success for the requested facts', async () => {
  const store = createResearchMemoryState()
  await store.update('session/session', () => ({
    value: {
      ownerUid: 'owner',
      jobId: 'job',
      input: {
        plateId: 'AZ.one',
        displayName: 'Wildlife',
        state: 'AZ',
        inputRevision: 'r1',
        baselineVersion: 14,
        requested: ['funFacts'],
      },
    },
    result: null,
  }))
  await store.update('evidence/job', () => ({ value: [source], result: null }))
  expect(
    await submitResearchDraft(
      { session: { id: 'session', turn: { id: 'turn' } } },
      draft({ facts: 1 }),
      store
    )
  ).toMatchObject({ status: 'ok', missing: [] })
})

test('manual acceptance keeps the valid items when one item is rejected', async () => {
  const { f, job, outcome } = await reported(
    { funFacts: [] },
    draft({ description: true, facts: 2 })
  )
  expect(outcome.ok).toBe(true)
  const accepted = await acceptResearch(f.deps, f.owner, {
    jobId: job.id,
    baseRevision: plateRevision(f.plate),
    fields: ['description', 'funFacts'],
    draft: {
      ...draft({ description: true, facts: 2 }),
      funFacts: [
        fact,
        {
          text: 'Volunteers counted 900 nesting eagles in Utah.',
          sourceId: 'S1',
        },
      ],
    },
  })
  expect(accepted).toMatchObject({
    ok: true,
    value: {
      skipped: [],
      rejected: [{ field: 'funFacts', reason: 'unsupported_claim' }],
    },
  })
  expect(
    (await f.review.store.getEdit('batch', f.plate.id))!.fields
  ).toMatchObject({
    description,
    funFacts: [{ text: fact.text, sourceUrl: source.url }],
  })
})

test('manual acceptance applies the valid fields and reports an empty one as skipped', async () => {
  const { f, job } = await reported(
    { funFacts: [] },
    draft({ description: true })
  )
  const accepted = await acceptResearch(f.deps, f.owner, {
    jobId: job.id,
    baseRevision: plateRevision(f.plate),
    fields: ['description', 'funFacts'],
  })
  expect(accepted).toMatchObject({
    ok: true,
    value: { skipped: ['funFacts'], rejected: [] },
  })
  expect(
    (await f.review.store.getEdit('batch', f.plate.id))!.fields
  ).toMatchObject({ description })
})

/** Build an attempt where Describe completed without contributing to the projection. */
function storyAfterDescribe(existing: string | null) {
  const describe: RunStep = {
    index: 0,
    plateId: 'AZ.one',
    stage: 'describe',
    resourceClass: 'gpu',
    status: 'completed',
    completedJobId: 'run-1-0',
  }
  const story: RunStep = {
    index: 1,
    plateId: 'AZ.one',
    stage: 'story',
    resourceClass: 'gpu',
  }
  const attempt = {
    steps: [describe, story],
    completedJobIds: ['run-1-0'],
  } as unknown as RunAttempt
  const plate = {
    executionPlate: { id: 'AZ.one', description: existing },
    sourceJobIds: [],
  } as unknown as ProjectedPlate
  return missingResearchInput(attempt, story, plate)
}

test('an existing description satisfies the Story dependency', () => {
  expect(storyAfterDescribe(description)).toBeUndefined()
  expect(storyAfterDescribe('   ')).toBe('missing_description')
  expect(storyAfterDescribe(null)).toBe('missing_description')
})

test('local story validation keeps the valid facts when one is rejected', () => {
  const local = {
    id: 'S1',
    kind: 'wikipedia' as const,
    title: 'Wildlife program',
    url: source.url,
    text,
  }
  const result = validateStory(
    {
      description: null,
      firstIssuedYear: null,
      funFacts: [
        { text: fact.text, source: 'S1' },
        {
          text: 'Volunteers counted 900 nesting eagles in Utah.',
          source: 'S1',
        },
      ],
    },
    [local]
  )
  expect(result.draft.funFacts).toEqual([
    { text: fact.text, sourceUrl: source.url, sourceTitle: 'Wildlife program' },
  ])
  expect(result.rejected).toHaveLength(1)
})

test('the hosted research request names only the fields the plate lacks', async () => {
  const { researchRequestMessage } = await import('../../lib/research/request')
  const base = {
    plateId: 'AZ.one',
    displayName: 'Wildlife',
    state: 'AZ',
    inputRevision: 'r1',
    baselineVersion: 14,
  }
  expect(
    researchRequestMessage({ ...base, requested: ['funFacts'] })
  ).toContain('The plate lacks only: funFacts.')
  expect(researchRequestMessage(base)).toContain(
    'The plate lacks only: description, funFacts.'
  )
})
