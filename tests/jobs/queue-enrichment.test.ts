import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { enqueueRun, enqueueSelection, listRuns, retryRun, cancelRun } from '../../lib/jobs/queue'
import { dispatchQueueStage, observeQueueStage } from '../../lib/jobs/queue-engine'
import { executeHostedQueueStage } from '../../lib/jobs/queue-hosted'
import { claimNext, getJob, reportResult } from '../../lib/jobs/jobs'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { applyQueueBundle } from '../../lib/jobs/queue-bundle'
import { createEnrichmentHandler } from '../../worker/pipeline/research'
import { executeQueueResearch } from '../../lib/research/queue-hosted'
import { createResearchMemoryState } from '../../lib/research/state'
import { evidenceSource } from '../../lib/research/evidence'
import type { Plate } from '../../lib/catalog/types'
import type { JobsDeps, TaggingJob } from '../../lib/jobs/types'
import type { EnrichmentPolicy } from '../../lib/research/enrichment'
import type { PipelineRun } from '../../lib/jobs/queue-types'

const actor = { uid: 'owner', role: 'owner' as const, name: null }
const source = evidenceSource({ kind: 'wikipedia', title: 'Alaska', url: 'https://en.wikipedia.org/wiki/Alaska', text: 'The Alaska Wildlife plate celebrates conservation of native wildlife and supports public education about bears. Alaska became a state in 1959 and has extensive northern wilderness. The Wildlife registration plate was introduced in 1976.' }, 100)
const draft = { description: 'The Alaska Wildlife plate celebrates native wildlife conservation and public education about bears.', descriptionSources: [source.id],
  funFacts: [{ text: 'Alaska became a state in 1959.', sourceId: source.id }], readMore: [source.id], wikiSource: source.id, firstIssuedYear: { year: 1976, sourceId: source.id } }
const saved = { description: 'Saved description', wikiUrl: source.url, funFacts: [{ text: 'Saved fact', sourceUrl: source.url }], readMore: [{ title: 'Saved source', site: 'Wikipedia', url: source.url }], firstIssuedYear: 1976 }
beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1'); vi.stubEnv('RESEARCH_ENABLE_MODEL_CALLS', 'true') })
afterEach(() => vi.unstubAllEnvs())

function setup() {
  const plates: Plate[] = [
    { id: 'AK.one', slug: 'one', state: 'AK', displayName: 'Wildlife', image: '', tags: [], ...saved, funFacts: [], readMore: [] },
    { id: 'AK.two', slug: 'two', state: 'AK', displayName: 'Wildlife', image: '', tags: [], ...saved, description: '  ', wikiUrl: null },
    { id: 'AK.complete', slug: 'complete', state: 'AK', displayName: 'Wildlife', image: '', tags: [], ...saved },
  ]
  const review = createMemoryStore([{ id: 'batch', name: 'Research', createdBy: actor.uid, createdAt: '', revision: 0, baselineVersion: 1, state: 'open', plateIds: plates.map(plate => plate.id), approval: null }])
  let seq = 0
  const jobs: JobsDeps = { store: createMemoryJobsStore(review, 'preview:local-pipeline-enrich'), localScope: 'enrich', baseline: async id => plates.find(plate => plate.id === id) ?? null,
    baselineAtVersion: async (_, id) => plates.find(plate => plate.id === id) ?? null, now: () => 1000, id: () => `claim-${++seq}`, leaseMs: 10000 }
  const capture = vi.fn(async (): Promise<{ sources: typeof source[]; wikiUrl: string | null }> => ({ sources: [source], wikiUrl: source.url }))
  const request = vi.fn(async () => Response.json({ message: { content: JSON.stringify(draft) }, eval_count: 120, prompt_eval_count: 800 }))
  const handler = createEnrichmentHandler({ url: 'http://ollama.test', capture, fetch: request })
  const state = createResearchMemoryState()
  const deliver = vi.fn(async (job: TaggingJob) => {
    await state.update(`draft/${job.id}`, () => ({ value: { draft }, result: null }))
    await state.update(`eve-outcome/${job.id}`, () => ({ value: { outcome: 'completed' }, result: null }))
    await state.update(`usage/${job.id}`, () => ({ value: { inputTokens: 800, outputTokens: 120 }, result: null }))
    await state.update(`model-attempts/${job.id}`, () => ({ value: [{ id: job.id, costUsd: 0.000128 }], result: null }))
    return { sessionId: `session-${job.id}`, deliveryId: 'delivery' }
  })
  const hosted = (job: TaggingJob) => executeQueueResearch(jobs, job, { state, capture, activeOwner: async () => true, deliver })
  return { jobs, plates, review, capture, request, handler, state, deliver, hosted }
}

test.each(['desktop', 'eve'] as const)('%s bulk Fill missing skips populated plates and fields, stores model/policy and applies one coherent draft', async executor => {
  const s = setup()
  const modelId = executor === 'eve' ? 'eve-gemini-2-5-flash-lite' : 'desktop-gemma4-26b'
  const created = await enqueueRun(s.jobs, actor, { requestId: 'bulk', batchId: 'batch', plateIds: s.plates.map(plate => plate.id), stages: ['research'], researchModelId: modelId })
  expect(created).toMatchObject({ ok: true, value: { researchModel: { id: modelId, model: executor === 'eve' ? 'google/gemini-2.5-flash-lite' : 'gemma4:26b' }, options: { research: { policy: 'fill-missing' } } } })
  if (!created.ok) throw Error(created.error)
  const run = created.value
  expect(run.attempts[0].steps.map(step => step.plateId)).toEqual(['AK.one', 'AK.two'])
  for (let index = 0; index < 2; index++) {
    const id = (await dispatchQueueStage({ ...s.jobs }, run.id, 1, index, `hook-${index}`))!
    const job = (await getJob(s.jobs, id))!
    expect(job).toMatchObject({ researchModel: run.researchModel, researchPolicy: 'fill-missing' })
    if (executor === 'eve') {
      expect(await claimNext(s.jobs, 'desktop')).toBeNull()
      expect(await executeHostedQueueStage(s.jobs, id, async () => { throw Error('Tag adapter must not execute research') }, s.hosted)).toBe('settled')
      expect(await executeHostedQueueStage(s.jobs, id, async () => { throw Error('duplicate') }, s.hosted)).toBe('settled')
    } else {
      const claim = (await claimNext(s.jobs, 'desktop'))!
      const result = await s.handler({ plate: claim.job.inputPlate!, model: claim.job.researchModel!.model, policy: claim.job.researchPolicy })
      expect(await reportResult(s.jobs, 'desktop', id, claim.claimId, { ...result, durationMs: 1 })).toMatchObject({ ok: true })
    }
    await observeQueueStage(s.jobs, run.id, 1, index)
  }
  expect(s.capture).toHaveBeenCalledTimes(2)
  expect(executor === 'eve' ? s.deliver : s.request).toHaveBeenCalledTimes(2)
  expect(await s.review.listEdits('batch')).toEqual([])
  const review = { store: s.review, baseline: s.jobs.baseline, baselineAtVersion: s.jobs.baselineAtVersion!, stateBaseline: async () => s.plates, now: () => 'now' }
  expect(await applyQueueBundle(s.jobs, review, actor, run.id)).toMatchObject({ ok: true, value: { revision: 1 } })
  const one = await s.review.getEdit('batch', 'AK.one')
  const two = await s.review.getEdit('batch', 'AK.two')
  expect(one?.fields).toMatchObject({ funFacts: [{ text: draft.funFacts[0].text, sourceUrl: source.url }], readMore: [{ url: source.url }] })
  expect(one?.fields).not.toHaveProperty('description')
  expect(two?.fields).toMatchObject({ description: draft.description, wikiUrl: source.url })
  expect(two?.fields).not.toHaveProperty('funFacts')
  expect(await s.review.getEdit('batch', 'AK.complete')).toBeNull()
  expect(await applyQueueBundle(s.jobs, review, actor, run.id)).toMatchObject({ value: { revision: 1 } })
})

test('a Run Pipeline selection saves one hosted result with its description and sourced facts to the Batch', async () => {
  const s = setup()
  const plateId = s.plates[0].id
  const created = await enqueueSelection(s.jobs, actor, {
    requestId: 'selection', batchId: 'batch', plateIds: [plateId], stages: ['research'],
    researchModelId: 'eve-gemini-2-5-flash-lite', options: { research: { policy: 'replace' } },
  })
  if (!created.ok) throw Error(created.error)
  const [run] = created.value
  expect(run.attempts[0].steps).toEqual([{ index: 0, plateId, stage: 'research', resourceClass: 'io' }])
  const id = (await dispatchQueueStage(s.jobs, run.id, 1, 0, 'selection-hook'))!
  expect(await executeHostedQueueStage(s.jobs, id, async () => { throw Error('No Tag jobs expected') }, s.hosted)).toBe('settled')
  await observeQueueStage(s.jobs, run.id, 1, 0)
  await observeQueueStage(s.jobs, run.id, 1, 0)
  expect(s.deliver).toHaveBeenCalledOnce()
  const fields = { description: draft.description, funFacts: [{ text: draft.funFacts[0].text, sourceUrl: source.url }] }
  expect(await listRuns(s.jobs, actor)).toMatchObject({ value: [{ id: run.id, status: 'completed', draftPlateIds: [plateId], jobs: [
    { id, researchModel: { id: 'eve-gemini-2-5-flash-lite' }, result: { fieldSuggestion: { stage: 'research', fields } } },
  ] }] })
  expect(await s.review.readBatch('batch')).toMatchObject({ batch: { revision: 1 }, edits: [{ plateId, fields }] })
})

test.each(['fill-missing', 'replace'] as EnrichmentPolicy[])('%s server projection refuses empty replacements and protects populated fields from worker overreach', async policy => {
  const s = setup()
  const created = await enqueueRun(s.jobs, actor, { requestId: 'policy', batchId: 'batch', plateIds: ['AK.one'], stages: ['research'], options: { research: { policy } } })
  if (!created.ok) throw Error(created.error)
  const id = (await dispatchQueueStage(s.jobs, created.value.id, 1, 0, 'hook'))!
  const claim = (await claimNext(s.jobs, 'desktop'))!
  expect(await reportResult(s.jobs, 'desktop', id, claim.claimId, { backend: 'ollama', model: 'gemma4:12b', promptVersion: 'fixture', durationMs: 1,
    fieldSuggestion: { kind: 'fields', stage: 'research', fields: { description: 'Proposed description', funFacts: [], readMore: [] }, sources: [source.url] } })).toMatchObject({ ok: true })
  const result = (await getJob(s.jobs, id))!.result!
  expect(result.fieldSuggestion?.kind === 'fields' && result.fieldSuggestion.fields).toEqual(policy === 'replace' ? { description: 'Proposed description' } : false)
  if (policy === 'fill-missing') expect(result.stageError).toBe('no_supported_fields')
  expect(await s.review.listEdits('batch')).toEqual([])
})

test.each(['desktop', 'eve'] as const)('%s standalone research refuses inference without fetched passages and Preview refuses Apply', async executor => {
  const s = setup()
  s.capture.mockResolvedValue({ sources: [], wikiUrl: null })
  const created = await enqueueRun(s.jobs, actor, { requestId: 'no-source', batchId: 'batch', plateIds: ['AK.one'], stages: ['research'], previewOnly: true,
    researchModelId: executor === 'eve' ? 'eve-gemini-2-5-flash-lite' : 'desktop-gemma4-12b' })
  if (!created.ok) throw Error(created.error)
  const id = (await dispatchQueueStage(s.jobs, created.value.id, 1, 0, 'hook'))!
  if (executor === 'eve') await executeHostedQueueStage(s.jobs, id, async () => { throw Error('Tag must not run') }, s.hosted)
  else {
    const claim = (await claimNext(s.jobs, 'desktop'))!
    await reportResult(s.jobs, 'desktop', id, claim.claimId, { ...await s.handler({ plate: claim.job.inputPlate! }), durationMs: 0 })
  }
  expect(s.request).not.toHaveBeenCalled(); expect(s.deliver).not.toHaveBeenCalled()
  expect((await getJob(s.jobs, id))?.result?.stageError).toBe('no_sources')
  await observeQueueStage(s.jobs, created.value.id, 1, 0)
  expect(await applyQueueBundle(s.jobs, { store: s.review, baseline: s.jobs.baseline, baselineAtVersion: s.jobs.baselineAtVersion!, stateBaseline: async () => s.plates, now: () => '' }, actor, created.value.id)).toMatchObject({ error: 'forbidden' })
  expect(await s.review.listEdits('batch')).toEqual([])
})

test('research model allowlist rejects arbitrary/expensive models and retries retain the saved model and policy', async () => {
  const s = setup()
  const input = { requestId: 'models', batchId: 'batch', plateIds: ['AK.one'], stages: ['research'] as const, options: { research: { policy: 'replace' as const } } }
  for (const modelId of ['openai/gpt-6.1-sol', 'gateway-gemma4-26b', 'arbitrary']) expect(await enqueueRun(s.jobs, actor, { ...input, stages: [...input.stages], researchModelId: modelId })).toMatchObject({ ok: false })
  expect(await enqueueRun(s.jobs, { ...actor, role: 'editor' }, { ...input, stages: [...input.stages], researchModelId: 'eve-gemini-2-5-flash-lite' })).toMatchObject({ error: 'invalid_state' })
  const created = await enqueueRun(s.jobs, actor, { ...input, stages: [...input.stages], researchModelId: 'desktop-gemma4-26b' })
  if (!created.ok) throw Error(created.error)
  await cancelRun(s.jobs, actor, created.value.id)
  expect(await retryRun(s.jobs, actor, created.value.id, 'retry')).toMatchObject({ value: { researchModel: { model: 'gemma4:26b' }, options: input.options } })
})

test('cancelling an Eve session retains its IO reservation until physical settlement, with no new dispatch', async () => {
  const s = setup()
  const pendingDelivery = vi.fn(async () => ({ sessionId: 'pending', deliveryId: 'delivery' }))
  const pending = (job: TaggingJob) => executeQueueResearch(s.jobs, job, { state: s.state, capture: s.capture, activeOwner: async () => true, deliver: pendingDelivery })
  const runs: PipelineRun[] = []
  const ids: string[] = []
  for (let index = 0; index < 3; index++) {
    const result = await enqueueRun(s.jobs, actor, { requestId: `pending-${index}`, batchId: 'batch', plateIds: ['AK.one'], stages: ['research'], researchModelId: 'eve-gemini-2-5-flash-lite' })
    if (!result.ok) throw Error(result.error)
    runs.push(result.value)
    ids.push((await dispatchQueueStage(s.jobs, result.value.id, 1, 0, `hook-${index}`))!)
  }
  const tag = async () => { throw Error('No Tag dispatch') }
  expect(await executeHostedQueueStage(s.jobs, ids[0], tag, pending)).toBe('waiting')
  expect(await executeHostedQueueStage(s.jobs, ids[1], tag, pending)).toBe('waiting')
  await cancelRun(s.jobs, actor, runs[0].id)
  expect(await executeHostedQueueStage(s.jobs, ids[0], tag, pending)).toBe('waiting')
  expect(await executeHostedQueueStage(s.jobs, ids[2], tag, pending)).toBe('waiting')
  expect(pendingDelivery).toHaveBeenCalledTimes(2)
  await s.state.update(`draft/${ids[0]}`, () => ({ value: { draft }, result: null }))
  await s.state.update(`eve-outcome/${ids[0]}`, () => ({ value: { outcome: 'completed' }, result: null }))
  expect(await executeHostedQueueStage(s.jobs, ids[0], tag, pending)).toBe('settled')
  await observeQueueStage(s.jobs, runs[0].id, 1, 0)
  expect((await s.jobs.store.transaction(tx => tx.runs())).find(run => run.id === runs[0].id)?.status).toBe('cancelled')
  expect(await executeHostedQueueStage(s.jobs, ids[2], tag, pending)).toBe('waiting')
  expect(pendingDelivery).toHaveBeenCalledTimes(3)
  expect(await s.review.listEdits('batch')).toEqual([])
})

test('retrieval failure and invalid synthesis never replace saved fields or retry with another model', async () => {
  const s = setup()
  s.capture.mockRejectedValueOnce(Error('Wikipedia unavailable'))
  await expect(s.handler({ plate: s.plates[0], policy: 'replace' })).rejects.toThrow('Wikipedia unavailable')
  expect(s.request).not.toHaveBeenCalled()
  s.request.mockResolvedValueOnce(Response.json({ message: { content: '{}' } }))
  expect(await s.handler({ plate: s.plates[0], policy: 'replace', model: 'desktop-gemma4-26b' })).toMatchObject({ stageError: 'no_supported_fields', model: 'gemma4:26b' })
  expect(s.request).toHaveBeenCalledOnce()
  expect(await s.review.listEdits('batch')).toEqual([])
})
