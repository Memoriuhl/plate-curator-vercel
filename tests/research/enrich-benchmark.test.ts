import { expect, test } from 'vitest'
import type { Plate } from '../../lib/catalog/types'
import type { TaggingJob } from '../../lib/jobs/types'
import {
  estimateEnrichCost,
  hostedEnrichBar,
  scoreEnrichRun,
  selectEnrichPlates,
  type EnrichManifest,
} from '../../lib/research/enrich-benchmark'
import { plateRevision } from '../../lib/review/revision'

const fact = { text: 'Saved fact.', sourceUrl: 'https://example.com/fact' }

/** Build a catalog plate with only the content fields a case needs. */
function plate(
  id: string,
  state: string,
  content: { description?: string; facts?: boolean } = {}
): Plate {
  return {
    id,
    state,
    slug: id,
    displayName: id,
    category: 'specialty',
    tags: [],
    image: `${id}.webp`,
    ...(content.description ? { description: content.description } : {}),
    ...(content.facts ? { funFacts: [fact] } : {}),
  } as unknown as Plate
}

const catalog = [
  plate('AL.a', 'AL', { description: 'Saved.' }),
  plate('AL.b', 'AL', { description: 'Saved.' }),
  plate('AL.c', 'AL'),
  plate('PA.a', 'PA', { description: 'Saved.' }),
  plate('PA.b', 'PA'),
  plate('PA.c', 'PA'),
  plate('PA.d', 'PA', { facts: true }),
  plate('TX.a', 'TX'),
  plate('TX.b', 'TX', { description: 'Saved.', facts: true }),
  plate('OH.a', 'OH'),
]

test('selection takes each case round-robin across the named states', () => {
  const selected = selectEnrichPlates(catalog, {
    states: ['AL', 'PA', 'TX'],
    counts: { both: 3, facts: 2, description: 1 },
    seed: 'v17',
  })
  expect(selected.shortfall).toEqual({})
  const byCase = (name: string) =>
    selected.plates.filter((entry) => entry.case === name)
  expect(
    byCase('both')
      .map((entry) => entry.state)
      .sort()
  ).toEqual(['AL', 'PA', 'TX'])
  expect(
    byCase('facts')
      .map((entry) => entry.state)
      .sort()
  ).toEqual(['AL', 'PA'])
  expect(byCase('description')).toEqual([
    expect.objectContaining({ plateId: 'PA.d', requested: ['description'] }),
  ])
  // A plate that needs nothing, and states outside the list, are never picked.
  expect(selected.plates.map((entry) => entry.plateId)).not.toContain('TX.b')
  expect(selected.plates.map((entry) => entry.plateId)).not.toContain('OH.a')
  expect(selected.plates.find((entry) => entry.plateId === 'TX.a')).toEqual({
    plateId: 'TX.a',
    displayName: 'TX.a',
    state: 'TX',
    inputRevision: plateRevision(catalog[7]),
    case: 'both',
    requested: ['description', 'funFacts'],
  })
})

test('selection is fixed by its seed', () => {
  const options = {
    states: ['AL', 'PA'],
    counts: { both: 1, facts: 1 },
  }
  const ids = (seed: string) =>
    selectEnrichPlates(catalog, { ...options, seed }).plates.map(
      (entry) => entry.plateId
    )
  expect(ids('v17')).toEqual(ids('v17'))
})

test('selection reports a case the catalog cannot fill', () => {
  const selected = selectEnrichPlates(catalog, {
    states: ['AL'],
    counts: { facts: 2, description: 3 },
    seed: 'v17',
  })
  expect(selected.plates).toHaveLength(2)
  expect(selected.shortfall).toEqual({ description: 3 })
})

test('selection refuses more plates than the benchmark allows', () => {
  expect(() =>
    selectEnrichPlates(catalog, {
      states: ['AL'],
      counts: { both: 30, facts: 11 },
      seed: 'v17',
    })
  ).toThrow('at most 40')
})

const manifest: EnrichManifest = {
  schemaVersion: 1,
  kind: 'enrich',
  baselineVersion: 17,
  createdAt: '2026-11-18T00:00:00Z',
  seed: 'v17',
  bar: hostedEnrichBar,
  plates: [
    {
      plateId: 'AL.c',
      displayName: 'AL.c',
      state: 'AL',
      inputRevision: 'r1',
      case: 'both',
      requested: ['description', 'funFacts'],
    },
    {
      plateId: 'PA.a',
      displayName: 'PA.a',
      state: 'PA',
      inputRevision: 'r2',
      case: 'facts',
      requested: ['funFacts'],
    },
    {
      plateId: 'PA.d',
      displayName: 'PA.d',
      state: 'PA',
      inputRevision: 'r3',
      case: 'description',
      requested: ['description'],
    },
    {
      plateId: 'TX.a',
      displayName: 'TX.a',
      state: 'TX',
      inputRevision: 'r4',
      case: 'both',
      requested: ['description', 'funFacts'],
    },
  ],
}

const minute = 60_000

/** Build a finished Research / enrich queue job for one plate. */
function job(
  plateId: string,
  overrides: Partial<TaggingJob> & {
    fields?: Record<string, unknown>
    sources?: string[]
    usage?: Record<string, number>
    durationMs?: number
  } = {}
): TaggingJob {
  const { fields, sources, usage, durationMs, ...rest } = overrides
  return {
    id: `job-${plateId}`,
    batchId: 'batch',
    plateId,
    requestedBy: 'owner',
    inputHash: 'hash',
    env: 'preview',
    route: 'hosted',
    stage: 'research',
    queueAttempt: 1,
    state: 'completed',
    createdAt: 0,
    endedAt: 2 * minute,
    result: {
      suggestions: [],
      backend: 'eve',
      model: 'google/gemini-2.5-flash-lite',
      promptVersion: 'enrichment-v3',
      durationMs: durationMs ?? 20_000,
      usage: usage ?? { modelCalls: 1, costUsd: 0.002 },
      ...(fields
        ? {
            fieldSuggestion: {
              kind: 'fields',
              stage: 'research',
              fields,
              sources: sources ?? ['https://example.com/a'],
            },
          }
        : { stageError: 'no_sources' }),
    },
    ...rest,
  } as TaggingJob
}

const cited = [{ text: 'A fact.', sourceUrl: 'https://example.com/a' }]

test('the score counts requested fields filled with cited evidence', () => {
  const score = scoreEnrichRun(manifest, [
    {
      createdAt: 0,
      jobs: [
        // Both requested, both filled.
        job('AL.c', { fields: { description: 'Text.', funFacts: cited } }),
        // Facts requested; an unrequested description does not count.
        job('PA.a', { fields: { description: 'Extra.', funFacts: cited } }),
        // Description requested; facts citing an uncaptured page do not count.
        job('PA.d', {
          fields: {
            funFacts: [{ text: 'A fact.', sourceUrl: 'https://other.example' }],
          },
        }),
        // Both requested; no sources found.
        job('TX.a'),
      ],
    },
  ])
  expect(score.requestedFields).toBe(6)
  expect(score.filledFields).toBe(3)
  expect(score.fillRate).toBe(0.5)
  expect(score.byCase).toEqual({
    both: { plates: 2, requested: 4, filled: 2, fillRate: 0.5 },
    facts: { plates: 1, requested: 1, filled: 1, fillRate: 1 },
    description: { plates: 1, requested: 1, filled: 0, fillRate: 0 },
  })
  expect(score.byField).toEqual({
    description: { requested: 3, filled: 1, fillRate: 1 / 3 },
    funFacts: { requested: 3, filled: 2, fillRate: 2 / 3 },
  })
  expect(score.rows.find((row) => row.plateId === 'TX.a')).toMatchObject({
    outcome: 'no_sources',
    filled: [],
  })
})

test('a failed or missing job counts as nothing filled and names why', () => {
  const score = scoreEnrichRun(manifest, [
    {
      jobs: [
        job('AL.c', { fields: { description: 'Text.', funFacts: cited } }),
        job('PA.a', {
          state: 'failed',
          failure: 'research_budget_exhausted',
          result: undefined,
          eve: { sessionId: 's', deliveryId: 'd' },
        }),
        // An earlier attempt is ignored in favour of the latest one.
        job('PA.d', { queueAttempt: 1, state: 'failed', result: undefined }),
        job('PA.d', {
          id: 'job-PA.d-2',
          queueAttempt: 2,
          fields: { description: 'Text.' },
        }),
      ],
    },
  ])
  expect(score.fillRate).toBe(3 / 6)
  expect(score.failed).toEqual([
    { plateId: 'PA.a', reason: 'research_budget_exhausted' },
    { plateId: 'TX.a', reason: 'not_run' },
  ])
  // The failed hosted job reached a model, so its charge is unknown.
  expect(score.cost).toMatchObject({ missing: 1, perPlateUsd: null })
})

/** Run the score over a fully filled set with the supplied timing and charges. */
function fullRun(options: {
  endedAt: number
  costUsd: number
  durations?: number[]
}) {
  const plates = Array.from({ length: 40 }, (_, index) => ({
    ...manifest.plates[0],
    plateId: `AL.p${index}`,
  }))
  const durations = options.durations ?? [20_000]
  return {
    manifest: { ...manifest, plates },
    runs: [
      {
        createdAt: 0,
        jobs: plates.map((entry, index) =>
          job(entry.plateId, {
            fields: { description: 'Text.', funFacts: cited },
            usage: { modelCalls: 1, costUsd: options.costUsd },
            durationMs: durations[index % durations.length],
            endedAt: options.endedAt,
          })
        ),
      },
    ],
  }
}

test('a run that fills, costs and finishes within the bar passes', () => {
  const { manifest: full, runs } = fullRun({
    endedAt: 14 * minute,
    costUsd: 0.003,
    durations: [10_000, 20_000, 30_000, 40_000],
  })
  const score = scoreEnrichRun(full, runs, { localFillRate: 0.95 })
  expect(score.cost).toEqual({
    usd: 0.12,
    perPlateUsd: 0.003,
    missing: 0,
  })
  expect(score.time).toEqual({
    wallMs: 14 * minute,
    p50Ms: 20_000,
    p90Ms: 40_000,
  })
  expect(score.bar).toEqual({
    fillRate: true,
    localGap: true,
    cost: true,
    time: true,
    passed: true,
  })
})

test('each bar condition fails on its own', () => {
  const slow = fullRun({ endedAt: 15 * minute, costUsd: 0.003 })
  expect(scoreEnrichRun(slow.manifest, slow.runs).bar).toMatchObject({
    time: false,
    passed: false,
  })
  const dear = fullRun({ endedAt: minute, costUsd: 0.011 })
  expect(scoreEnrichRun(dear.manifest, dear.runs).bar).toMatchObject({
    cost: false,
    passed: false,
  })
  const cheap = fullRun({ endedAt: minute, costUsd: 0.001 })
  // Hosted filled 100%, so a better local run cannot exist; a gap is only a fall short.
  expect(
    scoreEnrichRun(cheap.manifest, cheap.runs, { localFillRate: 1 }).bar
  ).toMatchObject({ localGap: true, passed: true })
  // Without the local run the comparison is unknown and the bar is not passed.
  expect(scoreEnrichRun(cheap.manifest, cheap.runs).bar).toMatchObject({
    localGap: null,
    passed: false,
  })
  const short = scoreEnrichRun(manifest, [
    {
      createdAt: 0,
      jobs: manifest.plates.map((entry) =>
        job(entry.plateId, {
          fields: { description: 'Text.', funFacts: cited },
        })
      ),
    },
  ])
  // Four plates cannot show that forty finish in time.
  expect(short.bar).toMatchObject({ fillRate: true, time: false })
})

test('a local desktop run reports no charge instead of an unknown one', () => {
  const score = scoreEnrichRun(manifest, [
    {
      jobs: manifest.plates.map((entry) =>
        job(entry.plateId, {
          route: 'local',
          fields: { description: 'Text.', funFacts: cited },
          usage: { modelCalls: 1 },
        })
      ),
    },
  ])
  expect(score.route).toBe('local')
  expect(score.cost).toEqual({ usd: null, perPlateUsd: null, missing: 0 })
  expect(score.bar.cost).toBeNull()
})

test('the cost estimate prices each call from evidence size', () => {
  const estimate = estimateEnrichCost(
    [
      { evidenceChars: 8_000, synthesis: true },
      { evidenceChars: 0, synthesis: false },
    ],
    {
      overheadTokens: 3_000,
      outputTokens: 500,
      callsPerPlate: 2,
      inputUsdPerMTok: 0.1,
      outputUsdPerMTok: 0.4,
    }
  )
  // (8000/4 + 3000) input and 500 output tokens, twice, for one plate with evidence.
  expect(estimate.totalUsd).toBeCloseTo(2 * (5_000 * 0.1e-6 + 500 * 0.4e-6))
  expect(estimate.perPlateUsd).toBeCloseTo(estimate.totalUsd / 2)
  expect(estimate.synthesisPlates).toBe(1)
})

test('evidence measurement captures sources without a model call', async () => {
  const { measureEnrichEvidence } =
    await import('../../worker/research-benchmark')
  const snapshot = {
    version: 17,
    plates: [catalog[2], catalog[0]],
  } as unknown as import('../../lib/catalog/types').Snapshot
  const source = {
    id: 'S1',
    kind: 'wikipedia' as const,
    title: 'Page',
    url: 'https://en.wikipedia.org/wiki/Page',
    fetchedAt: '2026-11-18T00:00:00Z',
    contentHash: 'hash',
    text: 'Evidence text.',
  }
  const prepare = async (plate: { id?: string }) =>
    plate.id === 'AL.c'
      ? { sources: [source], wikiUrl: source.url }
      : { sources: [], wikiUrl: null }
  const rows = await measureEnrichEvidence(
    {
      ...manifest,
      plates: [
        { ...manifest.plates[0], plateId: 'AL.c' },
        { ...manifest.plates[1], plateId: 'AL.a' },
      ],
    },
    snapshot,
    prepare as never
  )
  expect(rows).toEqual([
    expect.objectContaining({ plateId: 'AL.c', sources: 1, synthesis: true }),
    { plateId: 'AL.a', sources: 0, synthesis: false, evidenceChars: 0 },
  ])
  expect(rows[0].evidenceChars).toBeGreaterThan(source.text.length)
})

test('a saved run detail response, one run, or a list all load as runs', async () => {
  const { enrichRunRecords } = await import('../../worker/research-benchmark')
  const run = { createdAt: 1, jobs: [job('AL.c')] }
  expect(enrichRunRecords({ selected: run })).toEqual([run])
  expect(enrichRunRecords([run, run])).toHaveLength(2)
  expect(() => enrichRunRecords({ runs: [{ id: 'summary' }] })).toThrow(
    'no jobs'
  )
})
