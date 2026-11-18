import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  enqueueRun,
  enqueueSelection,
  listRuns,
  retryRun,
  cancelRun,
} from '../../lib/jobs/queue'
import {
  bindQueueWorkflow,
  dispatchQueueStage,
  observeQueueStage,
} from '../../lib/jobs/queue-engine'
import { executeHostedQueueStage } from '../../lib/jobs/queue-hosted'
import { claimNext, getJob, reportResult } from '../../lib/jobs/jobs'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import {
  readLocalWorkerCapabilities,
  reportLocalWorkerCapabilities,
} from '../../lib/jobs/capabilities'
import { createMemoryStore } from '../../lib/review/memory-store'
import { applyQueueBundle } from '../../lib/jobs/queue-bundle'
import {
  captureEnrichment,
  captureSavedEnrichment,
  createEnrichmentHandler,
  prepareEnrichment,
} from '../../worker/pipeline/research'
import { fetchResearchPage } from '../../lib/research/fetch-page'
import { enrichmentSuggestion } from '../../lib/research/enrichment-result'
import { executeQueueResearch } from '../../lib/research/queue-hosted'
import { createResearchMemoryState } from '../../lib/research/state'
import { evidenceSource } from '../../lib/research/evidence'
import { plateChecks } from '../../lib/catalog/plate-checks'
import { queueProgress } from '../../lib/jobs/run-progress'
import type { Plate } from '../../lib/catalog/types'
import type { JobsDeps, TaggingJob } from '../../lib/jobs/types'
import type { EnrichmentPolicy } from '../../lib/research/enrichment'
import type { PipelineRun } from '../../lib/jobs/queue-types'

const actor = { uid: 'owner', role: 'owner' as const, name: null }
const source = evidenceSource(
  {
    kind: 'wikipedia',
    title: 'Alaska',
    url: 'https://en.wikipedia.org/wiki/Alaska',
    text: 'The Alaska Wildlife plate celebrates conservation of native wildlife and supports public education about bears. Alaska became a state in 1959 and has extensive northern wilderness. The Wildlife registration plate was introduced in 1976.',
  },
  100
)
const draft = {
  description:
    'The Alaska Wildlife plate celebrates native wildlife conservation and public education about bears.',
  descriptionSources: [source.id],
  funFacts: [{ text: 'Alaska became a state in 1959.', sourceId: source.id }],
  readMore: [source.id],
  wikiSource: source.id,
  firstIssuedYear: { year: 1976, sourceId: source.id },
}
const saved = {
  description: 'Saved description',
  wikiUrl: source.url,
  funFacts: [{ text: 'Saved fact', sourceUrl: source.url }],
  readMore: [{ title: 'Saved source', site: 'Wikipedia', url: source.url }],
  firstIssuedYear: 1976,
}
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  vi.stubEnv('RESEARCH_ENABLE_MODEL_CALLS', 'true')
})
afterEach(() => vi.unstubAllEnvs())

/** Build a research queue fixture with local and hosted delivery controls. */
function setup(
  plates: Plate[] = [
    {
      id: 'AK.one',
      slug: 'one',
      state: 'AK',
      displayName: 'Wildlife',
      image: '',
      tags: [],
      ...saved,
      funFacts: [],
      readMore: [],
    },
    {
      id: 'AK.two',
      slug: 'two',
      state: 'AK',
      displayName: 'Wildlife',
      image: '',
      tags: [],
      ...saved,
      description: '  ',
      wikiUrl: null,
    },
    {
      id: 'AK.complete',
      slug: 'complete',
      state: 'AK',
      displayName: 'Wildlife',
      image: '',
      tags: [],
      ...saved,
    },
  ]
) {
  const review = createMemoryStore([
    {
      id: 'batch',
      name: 'Research',
      createdBy: actor.uid,
      createdAt: '',
      revision: 0,
      baselineVersion: 1,
      state: 'open',
      plateIds: plates.map((plate) => plate.id),
      approval: null,
    },
  ])
  let seq = 0
  const jobs: JobsDeps = {
    store: createMemoryJobsStore(review, 'preview:local-pipeline-enrich'),
    localScope: 'enrich',
    baseline: async (id) => plates.find((plate) => plate.id === id) ?? null,
    /** Resolve the plate by ID from the fixture baseline. */
    baselineAtVersion: async (_, id) =>
      plates.find((plate) => plate.id === id) ?? null,
    now: () => 1000,
    id: () => `claim-${++seq}`,
    leaseMs: 10000,
  }
  const capture = vi.fn(
    async (): Promise<{
      sources: (typeof source)[]
      wikiUrl: string | null
    }> => ({ sources: [source], wikiUrl: source.url })
  )
  const request = vi.fn(async () =>
    Response.json({
      message: { content: JSON.stringify(draft) },
      eval_count: 120,
      prompt_eval_count: 800,
    })
  )
  const captureSaved = vi.fn(
    async (plate: Pick<Plate, 'wikiUrl' | 'readMore'>) => ({
      sources: plate.wikiUrl || plate.readMore?.length ? [source] : [],
      wikiUrl: plate.wikiUrl ?? null,
    })
  )
  const handler = createEnrichmentHandler({
    url: 'http://ollama.test',
    capture,
    captureSaved,
    fetch: request,
  })
  const state = createResearchMemoryState()
  const deliver = vi.fn(async (job: TaggingJob) => {
    await state.update(`draft/${job.id}`, () => ({
      value: { draft },
      result: null,
    }))
    await state.update(`eve-outcome/${job.id}`, () => ({
      value: { outcome: 'completed' },
      result: null,
    }))
    await state.update(`usage/${job.id}`, () => ({
      value: { inputTokens: 800, outputTokens: 120 },
      result: null,
    }))
    await state.update(`model-attempts/${job.id}`, () => ({
      value: [{ id: job.id, costUsd: 0.000128 }],
      result: null,
    }))
    return { sessionId: `session-${job.id}`, deliveryId: 'delivery' }
  })
  /** Execute hosted enrichment using the fixture state and captured delivery requests. */
  const hosted = (job: TaggingJob) =>
    executeQueueResearch(jobs, job, {
      state,
      capture,
      captureSaved,
      activeOwner: async () => true,
      deliver,
    })
  return {
    jobs,
    plates,
    review,
    capture,
    captureSaved,
    request,
    handler,
    state,
    deliver,
    hosted,
  }
}

test.each([
  ['desktop', 'desktop-gemma4-26b', 'gemma4:26b'],
  ['eve', 'eve-gemini-2-5-flash-lite', 'google/gemini-2.5-flash-lite'],
  ['eve', 'eve-gemma4-26b', 'google/gemma-4-26b-a4b-it'],
] as const)(
  '%s model %s skips populated fields, stores model/policy and applies one coherent draft',
  async (executor, modelId, model) => {
    const s = setup()
    const created = await enqueueRun(s.jobs, actor, {
      requestId: 'bulk',
      batchId: 'batch',
      plateIds: s.plates.map((plate) => plate.id),
      stages: ['research'],
      researchModelId: modelId,
    })
    expect(created).toMatchObject({
      ok: true,
      value: {
        researchModel: { id: modelId, executor, model },
        options: { research: { policy: 'fill-missing' } },
      },
    })
    if (!created.ok) throw Error(created.error)
    const run = created.value
    expect(run.attempts[0].steps.map((step) => step.plateId)).toEqual([
      'AK.one',
      'AK.two',
    ])
    for (let index = 0; index < 2; index++) {
      const id = (await dispatchQueueStage(
        { ...s.jobs },
        run.id,
        1,
        index,
        `hook-${index}`
      ))!
      const job = (await getJob(s.jobs, id))!
      expect(job).toMatchObject({
        researchModel: run.researchModel,
        researchPolicy: 'fill-missing',
      })
      if (executor === 'eve') {
        expect(await claimNext(s.jobs, 'desktop')).toBeNull()
        expect(
          await executeHostedQueueStage(
            s.jobs,
            id,
            async () => {
              throw Error('Tag adapter must not execute research')
            },
            s.hosted
          )
        ).toBe('settled')
        expect(
          await executeHostedQueueStage(
            s.jobs,
            id,
            async () => {
              throw Error('duplicate')
            },
            s.hosted
          )
        ).toBe('settled')
      } else {
        const claim = (await claimNext(s.jobs, 'desktop'))!
        const result = await s.handler({
          plate: claim.job.inputPlate!,
          model: claim.job.researchModel!.model,
          policy: claim.job.researchPolicy,
        })
        expect(
          await reportResult(s.jobs, 'desktop', id, claim.claimId, {
            ...result,
            durationMs: 1,
          })
        ).toMatchObject({ ok: true })
      }
      expect(await getJob(s.jobs, id)).toMatchObject({ result: { model } })
      await observeQueueStage(s.jobs, run.id, 1, index)
    }
    expect(s.capture).toHaveBeenCalledTimes(1)
    expect(s.captureSaved).toHaveBeenCalledTimes(1)
    expect(executor === 'eve' ? s.deliver : s.request).toHaveBeenCalledTimes(2)
    expect(await s.review.listEdits('batch')).toEqual([])
    const review = {
      store: s.review,
      baseline: s.jobs.baseline,
      baselineAtVersion: s.jobs.baselineAtVersion!,
      stateBaseline: async () => s.plates,
      now: () => 'now',
    }
    expect(await applyQueueBundle(s.jobs, review, actor, run.id)).toMatchObject(
      { ok: true, value: { revision: 1 } }
    )
    const one = await s.review.getEdit('batch', 'AK.one')
    const two = await s.review.getEdit('batch', 'AK.two')
    expect(one?.fields).toMatchObject({
      funFacts: [{ text: draft.funFacts[0].text, sourceUrl: source.url }],
      readMore: [{ url: source.url }],
    })
    expect(one?.fields).not.toHaveProperty('description')
    expect(two?.fields).toMatchObject({
      description: draft.description,
      wikiUrl: source.url,
    })
    expect(two?.fields).not.toHaveProperty('funFacts')
    expect(await s.review.getEdit('batch', 'AK.complete')).toBeNull()
    expect(await applyQueueBundle(s.jobs, review, actor, run.id)).toMatchObject(
      { value: { revision: 1 } }
    )
  }
)

test.each(['desktop', 'eve'] as const)(
  '%s persists the lookup skip for just the plate with a usable saved reference',
  async (executor) => {
    const s = setup()
    s.plates[1].readMore = []
    const queued = await enqueueSelection(s.jobs, actor, {
      requestId: 'mixed-references',
      batchId: 'batch',
      plateIds: ['AK.one', 'AK.two'],
      stages: ['research'],
      researchModelId:
        executor === 'desktop'
          ? 'desktop-gemma4-26b'
          : 'eve-gemini-2-5-flash-lite',
    })
    if (!queued.ok) throw Error(queued.error)
    const [run] = queued.value
    for (const index of [0, 1]) {
      const id = (await dispatchQueueStage(
        s.jobs,
        run.id,
        1,
        index,
        `reference-${index}`
      ))!
      if (executor === 'eve')
        await executeHostedQueueStage(
          s.jobs,
          id,
          async () => {
            throw Error('unexpected Tag')
          },
          s.hosted
        )
      else {
        const claim = (await claimNext(s.jobs, 'desktop'))!
        const result = await s.handler({
          plate: claim.job.inputPlate!,
          ...claim.job.stageOptions,
          model: claim.job.researchModel!.model,
        })
        expect(
          await reportResult(s.jobs, 'desktop', id, claim.claimId, {
            ...result,
            durationMs: 1,
          })
        ).toMatchObject({ ok: true })
      }
      await observeQueueStage(s.jobs, run.id, 1, index)
    }
    expect(s.captureSaved).toHaveBeenCalledTimes(1)
    expect(s.capture).toHaveBeenCalledTimes(1)
    const savedRun = await listRuns(s.jobs, actor)
    if (!savedRun.ok) throw Error(savedRun.error)
    expect(
      queueProgress(savedRun.value[0]).steps.map((step) => [
        step.plateId,
        step.status,
        step.skippedPhases,
      ])
    ).toEqual([
      ['AK.one', 'completed', [0]],
      ['AK.two', 'completed', undefined],
    ])
  }
)

test('Fill missing searches when the saved reference cannot be fetched, while Replace existing searches directly', async () => {
  const s = setup()
  s.captureSaved.mockResolvedValue({ sources: [], wikiUrl: null })
  const result = await s.handler({ plate: s.plates[0], policy: 'fill-missing' })
  expect(s.captureSaved).toHaveBeenCalledTimes(1)
  expect(s.capture).toHaveBeenCalledTimes(1)
  expect(result).toMatchObject({
    fieldSuggestion: {
      kind: 'fields',
      fields: { funFacts: expect.any(Array) },
    },
  })
  expect(result).not.toHaveProperty('skippedPhases')

  await s.handler({ plate: s.plates[0], policy: 'replace' })
  expect(s.captureSaved).toHaveBeenCalledTimes(1)
  expect(s.capture).toHaveBeenCalledTimes(2)
})

test('Fill missing records a drafting skip and sends no inference when only the reference is missing', async () => {
  const s = setup()
  const result = await s.handler({
    plate: { ...s.plates[2], wikiUrl: null },
    policy: 'fill-missing',
  })
  expect(s.capture).toHaveBeenCalledOnce()
  expect(s.request).not.toHaveBeenCalled()
  expect(result).toMatchObject({
    skippedPhases: [1],
    fieldSuggestion: { fields: { wikiUrl: source.url } },
  })
})

test('saved-source capture only fetches saved links, deduplicates them and classifies fetched Wiki evidence', async () => {
  const museum = {
    ...source,
    url: 'https://museum.example/plate',
    kind: 'web' as const,
  }
  const fetchPage = vi
    .fn()
    .mockImplementation(async (url) =>
      url === source.url ? { ...source, kind: 'web' } : museum
    )
  const result = await captureSavedEnrichment(
    {
      wikiUrl: source.url,
      sourceUrl: source.url,
      readMore: [{ title: 'Museum', site: 'Museum', url: museum.url }],
      funFacts: [{ text: 'Saved fact', sourceUrl: museum.url }],
    },
    fetchPage
  )
  expect(fetchPage.mock.calls.map(([url]) => url)).toEqual([
    source.url,
    museum.url,
  ])
  expect(result).toEqual({ sources: [source, museum], wikiUrl: source.url })
})

test('Alaska Fill missing validates a fact from the exact DMV card even when the reference directory loses it', async () => {
  const directory = 'https://dmv.alaska.gov/vehicle-services/license-plates/'
  const details =
    'https://dmv.alaska.gov/vehicle-services/mobile-amateur-radio-operators/'
  const pages = new Map([
    [
      directory,
      '<title>Alaska DMV plates</title><main><h2>Personalized License Plates</h2><section><div><div>Grizzly Bear</div><img src="bear.png"><div>Initial: $0</div></div><div><div>Caribou</div><img src="caribou.png"><div>Initial: $30<br>Renewal: $0</div></div><div><div>Amateur Radio</div><div>(Call Sign)</div><img src="radio.png"><div>For FCC license holders. <a href="/vehicle-services/mobile-amateur-radio-operators/">Details</a></div></div></section></main>',
    ],
    [
      details,
      '<title>Alaska DMV Amateur Radio Plates</title><main><p>To receive an Alaska amateur radio license plate, the operator must provide proof that the vehicle carries a transceiver and receiver appropriate to the license class.</p><p>The Amateur Radio Call Sign plate displays the official FCC call sign, and the applicant must hold a valid FCC radio license to qualify for the registration.</p></main>',
    ],
  ])
  const fetchPage: typeof fetchResearchPage = (url, options) =>
    fetchResearchPage(url, {
      ...options,
      resolve: async () => ['93.184.216.34'],
      fetch: async (request) =>
        new Response(pages.get(String(request)), {
          status: pages.has(String(request)) ? 200 : 404,
          headers: { 'content-type': 'text/html' },
        }),
    })
  const captureSaved = async (
    plate: Parameters<typeof captureSavedEnrichment>[0],
    _: typeof fetchPage | undefined,
    requireReference?: boolean
  ) => captureSavedEnrichment(plate, fetchPage, requireReference)
  const capture = async () => ({ sources: [], wikiUrl: null })
  const caribou: Plate = {
    id: 'AK.caribou',
    slug: 'caribou',
    state: 'AK',
    displayName: 'Caribou',
    image: '',
    tags: [],
    description: 'Saved plate description',
    wikiUrl: directory,
  }
  const caribouResult = await prepareEnrichment(
    caribou,
    { policy: 'fill-missing' },
    { capture, captureSaved, fetchPage }
  )
  expect(caribouResult.sources).toHaveLength(1)
  expect(caribouResult.sources[0]).toMatchObject({
    url: directory,
    text: expect.stringContaining('Caribou'),
  })
  expect(caribouResult.sources[0].text).not.toContain('Grizzly Bear')
  const radio = {
    ...caribou,
    id: 'AK.amateur_radio_call_sign',
    displayName: 'Amateur Radio (Call Sign)',
    wikiUrl: 'https://en.wikipedia.org/wiki/Amateur_radio_call_signs',
    sourceUrl:
      'https://doa.alaska.gov/dmv/plates/Images/Standard/blue-n-gold.png',
  }
  const radioResult = await prepareEnrichment(
    radio,
    { policy: 'fill-missing' },
    { capture, captureSaved, fetchPage }
  )
  const official = radioResult.sources.find((source) => source.url === details)
  expect(official).toBeDefined()
  const suggestion = enrichmentSuggestion(
    {
      description: null,
      descriptionSources: [],
      readMore: [],
      wikiSource: null,
      funFacts: [
        {
          text: 'The Amateur Radio Call Sign plate displays the official FCC call sign.',
          sourceId: official?.id,
        },
      ],
    },
    radioResult.sources,
    radio,
    'fill-missing'
  )
  expect(suggestion?.kind === 'fields' && suggestion.fields).toEqual({
    funFacts: [
      {
        text: 'The Amateur Radio Call Sign plate displays the official FCC call sign.',
        sourceUrl: details,
        sourceTitle: 'Alaska DMV Amateur Radio Plates',
      },
    ],
  })
})

test('Alabama enrichment can draft a cited fact from the plate’s official page when Wikipedia is generic', async () => {
  const plate: Plate = {
    id: 'AL.alabama_forests',
    slug: 'alabama_forests',
    state: 'AL',
    displayName: 'Alabama Forests',
    image: '',
    tags: [],
    description: 'Saved plate description',
    sourceUrl: 'https://www.revenue.alabama.gov/wp-content/uploads/forests.jpg',
  }
  const official = evidenceSource({
    kind: 'web',
    title: 'Alabama Forests - Alabama Department of Revenue',
    url: 'https://www.revenue.alabama.gov/license-plates/alabama-forests/',
    text: 'The proceeds are distributed to the Alabama Forests Forever Foundation to promote professional management of trees and related resources.',
  })
  const title = 'Vehicle registration plates of Alabama'
  const request = vi.fn(async (url: string | URL | Request) => {
    const target = new URL(String(url))
    if (target.hostname === 'ollama.test')
      return Response.json({
        message: {
          content: JSON.stringify({
            description: null,
            descriptionSources: [],
            funFacts: [
              {
                text: 'Proceeds are distributed to the Alabama Forests Forever Foundation.',
                sourceId: official.id,
              },
            ],
            readMore: [official.id],
            wikiSource: null,
          }),
        },
      })
    if (target.searchParams.has('list'))
      return Response.json({ query: { search: [] } })
    if (target.searchParams.get('action') === 'parse')
      return Response.json({
        parse: {
          title,
          text: '<p>Alabama residents with registered motor vehicles are required to display vehicle registration plates issued by the state.</p>',
        },
      })
    return Response.json({ query: { pages: [{ title }] } })
  })
  const fetchPage = vi.fn(async () => official)
  const capture: typeof captureEnrichment = (input) =>
    captureEnrichment(input, request, fetchPage)
  const handler = createEnrichmentHandler({
    url: 'http://ollama.test',
    capture,
    fetch: request,
  })
  const { jobs, review } = setup([plate])
  const queued = await enqueueSelection(jobs, actor, {
    requestId: 'alabama-story',
    batchId: 'batch',
    plateIds: [plate.id],
    stages: ['research'],
  })
  if (!queued.ok) throw Error(queued.error)
  const [run] = queued.value
  const jobId = (await dispatchQueueStage(
    jobs,
    run.id,
    1,
    0,
    'alabama-story-hook'
  ))!
  const claim = (await claimNext(jobs, 'desktop'))!

  const result = await handler({
    plate: claim.job.inputPlate!,
    policy: 'fill-missing',
  })
  expect(
    await reportResult(jobs, 'desktop', jobId, claim.claimId, {
      ...result,
      durationMs: 1,
    })
  ).toMatchObject({ ok: true })
  expect(await observeQueueStage(jobs, run.id, 1, 0)).toEqual({ phase: 'done' })

  expect(fetchPage).toHaveBeenCalledWith(official.url, expect.any(Object))
  const edit = await review.getEdit('batch', plate.id)
  expect(edit?.fields).toMatchObject({
    funFacts: [
      {
        text: 'Proceeds are distributed to the Alabama Forests Forever Foundation.',
        sourceUrl: official.url,
      },
    ],
  })
  expect(plateChecks({ ...plate, ...edit?.fields }, null).funFacts.status).toBe(
    'good'
  )
})

test.each(['desktop', 'eve'] as const)(
  '%s skips a plate without saved evidence and continues to the next plate',
  async (executor) => {
    const s = setup()
    s.plates[0].wikiUrl = null
    const model =
      executor === 'eve' ? 'eve-gemini-2-5-flash-lite' : 'desktop-gemma4-12b'
    const created = await enqueueRun(s.jobs, actor, {
      requestId: 'saved-sources',
      batchId: 'batch',
      plateIds: ['AK.one', 'AK.two'],
      stages: ['research'],
      researchModelId: model,
      options: {
        research: { policy: 'fill-missing', reuseSavedSources: true },
      },
    })
    if (!created.ok) throw Error(created.error)
    const run = created.value
    for (let index = 0; index < 2; index++) {
      const id = (await dispatchQueueStage(
        s.jobs,
        run.id,
        1,
        index,
        `hook-${index}`
      ))!
      expect((await getJob(s.jobs, id))?.stageOptions).toMatchObject({
        reuseSavedSources: true,
      })
      if (executor === 'eve')
        await executeHostedQueueStage(
          s.jobs,
          id,
          async () => {
            throw Error('unexpected Tag')
          },
          s.hosted
        )
      else {
        expect(await claimNext(s.jobs, 'old-worker')).toBeNull()
        const claim = (await claimNext(s.jobs, 'new-worker', {
          supportsSavedSources: true,
        }))!
        const result = await s.handler({
          plate: claim.job.inputPlate!,
          model,
          ...claim.job.stageOptions,
        })
        expect(
          await reportResult(s.jobs, 'new-worker', id, claim.claimId, {
            ...result,
            durationMs: 1,
          })
        ).toMatchObject({ ok: true })
      }
      expect((await observeQueueStage(s.jobs, run.id, 1, index)).phase).toBe(
        index === 0 ? 'next' : 'done'
      )
    }
    expect(s.capture).not.toHaveBeenCalled()
    expect(s.captureSaved).toHaveBeenCalledTimes(2)
    expect(executor === 'eve' ? s.deliver : s.request).toHaveBeenCalledOnce()
    expect(await listRuns(s.jobs, actor)).toMatchObject({
      value: [
        {
          status: 'completed',
          attempts: [
            {
              outcome: 'partial',
              steps: [
                { status: 'skipped', reason: 'no_saved_sources' },
                { status: 'completed' },
              ],
            },
          ],
        },
      ],
    })
  }
)

test.each([
  [undefined, 'stage_failed'],
  ['research_budget_exhausted', 'research_budget_exhausted'],
])(
  'a hosted Research failure (%s) records its reason and does not stop the next plate',
  async (error, reason) => {
    const s = setup()
    s.deliver.mockImplementationOnce(async (job) => {
      await s.state.update(`eve-outcome/${job.id}`, () => ({
        value: { outcome: 'failed', error },
        result: null,
      }))
      return { sessionId: `session-${job.id}`, deliveryId: 'delivery' }
    })
    const created = await enqueueSelection(s.jobs, actor, {
      requestId: 'hosted-research-failure',
      batchId: 'batch',
      plateIds: ['AK.one', 'AK.two'],
      stages: ['research'],
      researchModelId: 'eve-gemini-2-5-flash-lite',
    })
    if (!created.ok) throw Error(created.error)
    const [run] = created.value
    for (const index of [0, 1]) {
      const id = (await dispatchQueueStage(
        s.jobs,
        run.id,
        1,
        index,
        `hook-${index}`
      ))!
      expect(
        await executeHostedQueueStage(
          s.jobs,
          id,
          async () => {
            throw Error('unexpected Tag')
          },
          s.hosted
        )
      ).toBe('settled')
      expect(await observeQueueStage(s.jobs, run.id, 1, index)).toEqual({
        phase: index === 0 ? 'next' : 'done',
      })
    }
    expect(await listRuns(s.jobs, actor)).toMatchObject({
      value: [
        {
          status: 'completed',
          draftPlateIds: ['AK.two'],
          attempts: [
            {
              outcome: 'partial',
              steps: [{ status: 'failed', reason }, { status: 'completed' }],
            },
          ],
        },
      ],
    })
  }
)

test('a Run Pipeline selection saves one hosted result with its description and sourced facts to the Batch', async () => {
  const s = setup()
  const plateId = s.plates[0].id
  const created = await enqueueSelection(s.jobs, actor, {
    requestId: 'selection',
    batchId: 'batch',
    plateIds: [plateId],
    stages: ['research'],
    researchModelId: 'eve-gemini-2-5-flash-lite',
    options: { research: { policy: 'replace', reuseSavedSources: true } },
  })
  if (!created.ok) throw Error(created.error)
  const [run] = created.value
  expect(run.attempts[0].steps).toEqual([
    { index: 0, plateId, stage: 'research', resourceClass: 'io' },
  ])
  const id = (await dispatchQueueStage(s.jobs, run.id, 1, 0, 'selection-hook'))!
  expect(
    await executeHostedQueueStage(
      s.jobs,
      id,
      async () => {
        throw Error('No Tag jobs expected')
      },
      s.hosted
    )
  ).toBe('settled')
  await observeQueueStage(s.jobs, run.id, 1, 0)
  await observeQueueStage(s.jobs, run.id, 1, 0)
  expect(s.deliver).toHaveBeenCalledOnce()
  expect(s.capture).toHaveBeenCalledOnce()
  expect(s.captureSaved).not.toHaveBeenCalled()
  const fields = {
    description: draft.description,
    funFacts: [{ text: draft.funFacts[0].text, sourceUrl: source.url }],
  }
  expect(await listRuns(s.jobs, actor)).toMatchObject({
    value: [
      {
        id: run.id,
        status: 'completed',
        draftPlateIds: [plateId],
        jobs: [
          {
            id,
            researchModel: { id: 'eve-gemini-2-5-flash-lite' },
            result: { fieldSuggestion: { stage: 'research', fields } },
          },
        ],
      },
    ],
  })
  expect(await s.review.readBatch('batch')).toMatchObject({
    batch: { revision: 1 },
    edits: [{ plateId, fields }],
  })
})

test.each(['fill-missing', 'replace'] as EnrichmentPolicy[])(
  '%s server projection refuses empty replacements and protects populated fields from worker overreach',
  async (policy) => {
    const s = setup()
    const created = await enqueueRun(s.jobs, actor, {
      requestId: 'policy',
      batchId: 'batch',
      plateIds: ['AK.one'],
      stages: ['research'],
      options: { research: { policy } },
    })
    if (!created.ok) throw Error(created.error)
    const id = (await dispatchQueueStage(
      s.jobs,
      created.value.id,
      1,
      0,
      'hook'
    ))!
    const claim = (await claimNext(s.jobs, 'desktop'))!
    expect(
      await reportResult(s.jobs, 'desktop', id, claim.claimId, {
        backend: 'ollama',
        model: 'gemma4:12b',
        promptVersion: 'fixture',
        durationMs: 1,
        fieldSuggestion: {
          kind: 'fields',
          stage: 'research',
          fields: {
            description: 'Proposed description',
            funFacts: [],
            readMore: [],
          },
          sources: [source.url],
        },
      })
    ).toMatchObject({ ok: true })
    const result = (await getJob(s.jobs, id))!.result!
    expect(
      result.fieldSuggestion?.kind === 'fields' && result.fieldSuggestion.fields
    ).toEqual(
      policy === 'replace' ? { description: 'Proposed description' } : false
    )
    if (policy === 'fill-missing')
      expect(result.stageError).toBe('no_supported_fields')
    expect(await s.review.listEdits('batch')).toEqual([])
  }
)

test.each(['desktop', 'eve'] as const)(
  '%s standalone research refuses inference without fetched passages and Preview refuses Apply',
  async (executor) => {
    const s = setup()
    s.capture.mockResolvedValue({ sources: [], wikiUrl: null })
    s.captureSaved.mockResolvedValue({ sources: [], wikiUrl: null })
    const created = await enqueueRun(s.jobs, actor, {
      requestId: 'no-source',
      batchId: 'batch',
      plateIds: ['AK.one'],
      stages: ['research'],
      previewOnly: true,
      researchModelId:
        executor === 'eve' ? 'eve-gemini-2-5-flash-lite' : 'desktop-gemma4-12b',
    })
    if (!created.ok) throw Error(created.error)
    const id = (await dispatchQueueStage(
      s.jobs,
      created.value.id,
      1,
      0,
      'hook'
    ))!
    if (executor === 'eve')
      await executeHostedQueueStage(
        s.jobs,
        id,
        async () => {
          throw Error('Tag must not run')
        },
        s.hosted
      )
    else {
      const claim = (await claimNext(s.jobs, 'desktop'))!
      await reportResult(s.jobs, 'desktop', id, claim.claimId, {
        ...(await s.handler({ plate: claim.job.inputPlate! })),
        durationMs: 0,
      })
    }
    expect(s.request).not.toHaveBeenCalled()
    expect(s.deliver).not.toHaveBeenCalled()
    expect((await getJob(s.jobs, id))?.result?.stageError).toBe('no_sources')
    await observeQueueStage(s.jobs, created.value.id, 1, 0)
    expect(
      await applyQueueBundle(
        s.jobs,
        {
          store: s.review,
          baseline: s.jobs.baseline,
          baselineAtVersion: s.jobs.baselineAtVersion!,
          stateBaseline: async () => s.plates,
          now: () => '',
        },
        actor,
        created.value.id
      )
    ).toMatchObject({ error: 'forbidden' })
    expect(await s.review.listEdits('batch')).toEqual([])
  }
)

test('research model allowlist rejects arbitrary/expensive models and retries retain the saved model and policy', async () => {
  const s = setup()
  const input = {
    requestId: 'models',
    batchId: 'batch',
    plateIds: ['AK.one'],
    stages: ['research'] as const,
    options: { research: { policy: 'replace' as const } },
  }
  for (const modelId of [
    'openai/gpt-6.1-sol',
    'gateway-gemma4-26b',
    'arbitrary',
  ])
    expect(
      await enqueueRun(s.jobs, actor, {
        ...input,
        stages: [...input.stages],
        researchModelId: modelId,
      })
    ).toMatchObject({ ok: false })
  const hosted = {
    ...input,
    stages: [...input.stages],
    researchModelId: 'eve-gemma4-26b',
  }
  expect(
    await enqueueRun(s.jobs, { ...actor, role: 'editor' }, hosted)
  ).toMatchObject({ error: 'invalid_state' })
  vi.stubEnv('RESEARCH_ENABLE_MODEL_CALLS', 'false')
  expect(await enqueueRun(s.jobs, actor, hosted)).toMatchObject({
    error: 'invalid_state',
  })
  const created = await enqueueRun(s.jobs, actor, {
    ...input,
    stages: [...input.stages],
    researchModelId: 'desktop-gemma4-26b',
  })
  if (!created.ok) throw Error(created.error)
  await cancelRun(s.jobs, actor, created.value.id)
  expect(
    await retryRun(s.jobs, actor, created.value.id, 'retry')
  ).toMatchObject({
    value: { researchModel: { model: 'gemma4:26b' }, options: input.options },
  })
})

test('cancelling an Eve session retains its IO reservation until physical settlement, with no new dispatch', async () => {
  const s = setup()
  const pendingDelivery = vi.fn(async () => ({
    sessionId: 'pending',
    deliveryId: 'delivery',
  }))
  /**
   * Poll hosted research with an unresolved delivery so the test can inspect the waiting
   * outcome.
   */
  const pending = (job: TaggingJob) =>
    executeQueueResearch(s.jobs, job, {
      state: s.state,
      capture: s.capture,
      captureSaved: s.captureSaved,
      activeOwner: async () => true,
      deliver: pendingDelivery,
    })
  const runs: PipelineRun[] = []
  const ids: string[] = []
  for (let index = 0; index < 3; index++) {
    const requester = index ? { ...actor, uid: `owner-${index}` } : actor
    const result = await enqueueRun(s.jobs, requester, {
      requestId: `pending-${index}`,
      batchId: 'batch',
      plateIds: ['AK.one'],
      stages: ['research'],
      researchModelId: 'eve-gemini-2-5-flash-lite',
    })
    if (!result.ok) throw Error(result.error)
    runs.push(result.value)
    ids.push(
      (await dispatchQueueStage(
        s.jobs,
        result.value.id,
        1,
        0,
        `hook-${index}`
      ))!
    )
  }
  /** Fail if the workflow sends research through the tagging executor. */
  const tag = async () => {
    throw Error('No Tag dispatch')
  }
  expect(await executeHostedQueueStage(s.jobs, ids[0], tag, pending)).toBe(
    'waiting'
  )
  expect(await executeHostedQueueStage(s.jobs, ids[1], tag, pending)).toBe(
    'waiting'
  )
  await cancelRun(s.jobs, actor, runs[0].id)
  expect(await executeHostedQueueStage(s.jobs, ids[0], tag, pending)).toBe(
    'waiting'
  )
  expect(await executeHostedQueueStage(s.jobs, ids[2], tag, pending)).toBe(
    'waiting'
  )
  expect(pendingDelivery).toHaveBeenCalledTimes(2)
  await s.state.update(`draft/${ids[0]}`, () => ({
    value: { draft },
    result: null,
  }))
  await s.state.update(`eve-outcome/${ids[0]}`, () => ({
    value: { outcome: 'completed' },
    result: null,
  }))
  expect(await executeHostedQueueStage(s.jobs, ids[0], tag, pending)).toBe(
    'settled'
  )
  await observeQueueStage(s.jobs, runs[0].id, 1, 0)
  expect(
    (await s.jobs.store.transaction((tx) => tx.runs())).find(
      (run) => run.id === runs[0].id
    )?.status
  ).toBe('cancelled')
  expect(await executeHostedQueueStage(s.jobs, ids[2], tag, pending)).toBe(
    'waiting'
  )
  expect(pendingDelivery).toHaveBeenCalledTimes(3)
  expect(await s.review.listEdits('batch')).toEqual([])
})

test('retrieval failure and invalid synthesis never replace saved fields or retry with another model', async () => {
  const s = setup()
  s.capture.mockRejectedValueOnce(Error('Wikipedia unavailable'))
  await expect(
    s.handler({ plate: s.plates[0], policy: 'replace' })
  ).rejects.toThrow('Wikipedia unavailable')
  expect(s.request).not.toHaveBeenCalled()
  s.request.mockResolvedValueOnce(Response.json({ message: { content: '{}' } }))
  expect(
    await s.handler({
      plate: s.plates[0],
      policy: 'replace',
      model: 'desktop-gemma4-26b',
    })
  ).toMatchObject({ stageError: 'no_supported_fields', model: 'gemma4:26b' })
  expect(s.request).toHaveBeenCalledOnce()
  expect(await s.review.listEdits('batch')).toEqual([])
})

test('saved-source research reports an incompatible worker using the same condition as the claim', async () => {
  const s = setup()
  const created = await enqueueRun(s.jobs, actor, {
    requestId: 'saved-source-worker',
    batchId: 'batch',
    plateIds: [s.plates[0].id],
    stages: ['research'],
    researchModelId: 'desktop-gemma4-26b',
    options: { research: { policy: 'fill-missing', reuseSavedSources: true } },
  })
  if (!created.ok) throw Error(created.error)
  const run = created.value
  await bindQueueWorkflow(s.jobs, run.id, 1, 'workflow-saved-sources')
  await dispatchQueueStage(s.jobs, run.id, 1, 0, 'hook-saved-sources')
  const list = async () =>
    listRuns(s.jobs, actor, await readLocalWorkerCapabilities(s.jobs))
  const available = { available: true }
  const capabilities = {
    group: available,
    embeddings: available,
    mask: available,
    vision: available,
    pollIntervalMs: 5000,
  }
  await reportLocalWorkerCapabilities(s.jobs, 'worker', capabilities, false)
  expect(await list()).toMatchObject({
    value: [{ id: run.id, queueWait: 'saved_sources_worker' }],
  })
  expect(await claimNext(s.jobs, 'worker')).toBeNull()

  await reportLocalWorkerCapabilities(s.jobs, 'worker', capabilities, true)
  expect(await list()).toMatchObject({
    value: [{ id: run.id, queueWait: 'worker_claim' }],
  })
  expect(
    await claimNext(s.jobs, 'worker', { supportsSavedSources: true })
  ).toMatchObject({ job: { queueRunId: run.id } })
})
