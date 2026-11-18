import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { localJobsEnvironment } from '../../lib/jobs/local-scope'
import { enqueueRun, parseEnqueue } from '../../lib/jobs/queue'
import { parsePipelineOptions } from '../../lib/jobs/pipeline-options'
import type { JobsDeps } from '../../lib/jobs/types'
import { dispatchQueueStage } from '../../lib/jobs/queue-engine'

const editor = { uid: 'editor', role: 'editor' as const, name: null }
const other = { ...editor, uid: 'other' }
const owner = { ...editor, uid: 'owner', role: 'owner' as const }
const input = { requestId: 'request-one', batchId: 'batch', plateIds: ['AK.one'], stages: ['describe', 'story', 'tag'] as const }
const request = { ...input, stages: [...input.stages] }

/** Provide a scoped one-plate queue store for tests of durable run record limits. */
function setup() {
  const plate = { id: 'AK.one', state: 'AK', slug: 'one', displayName: 'One', image: '', tags: [] }
  const review = createMemoryStore([{ id: 'batch', name: 'Queue', createdBy: editor.uid, createdAt: '', revision: 0, state: 'open', baselineVersion: 1, plateIds: [plate.id], approval: null }])
  const store = createMemoryJobsStore(review, localJobsEnvironment('test-queue'))
  const deps: JobsDeps = { store, localScope: 'test-queue', /** Provide the baseline plate data used by the review or job scenario. */ baseline: async id => id === plate.id ? plate : null,
    /** Pin the operation clock so timestamps and lease checks are reproducible. */
    now: () => 100, /** Supply a deterministic ID so the test can identify the generated record. */ id: () => 'claim', leaseMs: 1000 }
  return { plate, review, deps }
}

beforeEach(() => vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1'))
afterEach(() => vi.unstubAllEnvs())

test('durable enqueue snapshots selected stages/options and deduplicates concurrent requests across server instances', async () => {
  const { deps, review } = setup()
  const results = await Promise.all(Array.from({ length: 8 }, () => enqueueRun({ ...deps }, editor, request)))
  expect(results.every(result => result.ok)).toBe(true)
  const first = results[0]
  if (!first.ok) throw Error('Expected run')
  expect(new Set(results.map(result => result.ok && result.value.id)).size).toBe(1)
  const recovered = await { ...deps }.store.transaction(tx => tx.runs())
  expect(recovered).toHaveLength(1)
  expect(recovered[0]).toMatchObject({ id: first.value.id, stages: request.stages, requestedBy: editor.uid,
    options: { story: { redoExisting: false }, tag: { onlyUnderTagged: false } }, previewOnly: false, attempts: [{ number: 1, status: 'queued', projection: { baselineVersion: 1 } }] })
  expect(await deps.store.transaction(tx => tx.list())).toEqual([])
  expect(await review.listEdits('batch')).toEqual([])
  expect(await enqueueRun(deps, editor, { ...request, stages: ['tag'] })).toEqual({ ok: false, error: 'request_mismatch' })
})

test('request dedupe includes immutable options and preview mode', async () => {
  const { deps } = setup()
  const withOptions = { ...request, previewOnly: true, options: { tag: { onlyUnderTagged: true } } }
  const result = await enqueueRun(deps, editor, withOptions)
  expect(result).toMatchObject({ ok: true, value: { previewOnly: true, options: withOptions.options } })
  expect(await enqueueRun(deps, editor, { ...withOptions, previewOnly: false })).toMatchObject({ error: 'request_mismatch' })
  expect(await enqueueRun(deps, editor, { ...withOptions, options: {} })).toMatchObject({ error: 'request_mismatch' })
})

test('enqueue requires local flag, server scope and exact isolated job environment', async () => {
  const { deps } = setup()
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  expect(await enqueueRun(deps, editor, request)).toMatchObject({ error: 'forbidden' })
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  expect(await enqueueRun({ ...deps, localScope: undefined }, editor, request)).toMatchObject({ error: 'forbidden' })
  expect(await enqueueRun({ ...deps, localScope: 'another' }, editor, request)).toMatchObject({ error: 'forbidden' })
  expect(await enqueueRun({ ...deps, store: { ...deps.store, env: 'production' } }, editor, request)).toMatchObject({ error: 'forbidden' })
})

test('only Batch creator and Owner can enqueue, and submitted Batches reject even owners and duplicate requests', async () => {
  const { deps, review } = setup()
  expect(await enqueueRun(deps, other, request)).toMatchObject({ error: 'forbidden' })
  expect(await enqueueRun(deps, owner, request)).toMatchObject({ ok: true })
  const batch = (await review.getBatch('batch'))!
  await review.commit('batch', 0, { batch: { ...batch, revision: 1, state: 'submitted' } })
  expect(await enqueueRun(deps, owner, request)).toMatchObject({ error: 'invalid_state' })
  expect(await enqueueRun(deps, editor, { ...request, requestId: 'another' })).toMatchObject({ error: 'invalid_state' })
})

test('requests validate selected plates and reject manual order, duplicated stages/plates, unknown options', async () => {
  const { deps } = setup()
  expect(await enqueueRun(deps, editor, { ...request, plateIds: ['AK.missing'] })).toMatchObject({ error: 'not_found' })
  for (const value of [null, {}, { ...request, stages: ['order'] }, { ...request, stages: ['tag', 'tag'] },
    { ...request, plateIds: ['AK.one', 'AK.one'] }, { ...request, previewOnly: 'yes' },
    { ...request, options: { group: { hardCancel: true } } }, { ...request, plateIds: Array(26).fill('AK.one') }]) expect(parseEnqueue(value)).toBeNull()
})

test('option parser snapshots defaults, validates unknown keys and never coerces invalid booleans/methods', () => {
  expect(parsePipelineOptions({ group: { colorSignal: false } })).toEqual({ group: {
    method: 'embeddings', colorSignal: false, backgroundMask: false, visionTiebreak: false,
  } })
  expect(parsePipelineOptions({ group: { method: 'invented' } })).toBeNull()
  expect(parsePipelineOptions({ group: { colorSignal: 'false' } })).toBeNull()
  expect(parsePipelineOptions({ unknown: {} })).toBeNull()
  expect(parsePipelineOptions({ group: { method: 'vision' } })).toBeNull()
})

test('unchecked default Story option skips existing stories while preserving other selected stages and exact retry options', async () => {
  const s = setup()
  const deps = { ...s.deps, /** Provide the baseline plate data used by the review or job scenario. */ baseline: async () => ({ ...s.plate, funFacts: [{ text: 'Already accepted', sourceUrl: 'https://example.org/source' }] }) }
  const result = await enqueueRun(deps, editor, { ...request, stages: ['story', 'describe'] })
  expect(result).toMatchObject({ ok: true, value: { options: { story: { redoExisting: false } }, attempts: [{ steps: [{ stage: 'describe' }] }] } })
  const redo = await enqueueRun(deps, editor, { ...request, requestId: 'explicit-redo', stages: ['story', 'describe'], options: { story: { redoExisting: true } } })
  expect(redo).toMatchObject({ ok: true, value: { options: { story: { redoExisting: true } }, attempts: [{ steps: [{ stage: 'describe' }, { stage: 'story' }] }] } })
})

test('model-free Wiki, image and CPU Group runs persist no model even when only gateway models are enabled', async () => {
  vi.stubEnv('TAGGING_MODELS', 'gateway-gemma4-26b')
  const s = setup()
  const deps = { ...s.deps, /** Return the fixture state order used by the review or queue operation. */ stateBaseline: async () => [s.plate] }
  for (const stage of ['wiki-link', 'find-image', 'group'] as const) {
    const result = await enqueueRun(deps, editor, { ...request, requestId: stage, stages: [stage] })
    if (!result.ok) throw Error(result.error)
    expect(result.value).not.toHaveProperty('modelId')
    const id = await dispatchQueueStage(deps, result.value.id, 1, 0, `hook-${stage}`)
    expect(await deps.store.transaction(tx => tx.get(id!))).not.toHaveProperty('modelId')
  }
  expect(await enqueueRun(deps, editor, { ...request, requestId: 'tie', stages: ['group'], options: { group: { method: 'embeddings', colorSignal: false, backgroundMask: false, visionTiebreak: true } } })).toMatchObject({ error: 'invalid_state' })
  const ignored = await enqueueRun(deps, editor, { ...request, requestId: 'irrelevant-model', stages: ['wiki-link'], modelId: 'gateway-gemma4-26b' })
  expect(ignored).toMatchObject({ ok: true })
  if (ignored.ok) expect(ignored.value).not.toHaveProperty('modelId')
  expect(await enqueueRun(deps, editor, { ...request, requestId: 'unknown', modelId: 'unknown' })).toMatchObject({ error: 'bad_request' })
})

test('a skipped existing Story does not require a model for the remaining Wiki step', async () => {
  vi.stubEnv('TAGGING_MODELS', 'gateway-gemma4-26b')
  const s = setup()
  const deps = { ...s.deps, /** Provide the baseline plate data used by the review or job scenario. */ baseline: async () => ({ ...s.plate, funFacts: [{ text: 'Existing fact', sourceUrl: 'https://example.org/source' }] }) }
  expect(await enqueueRun(deps, editor, { ...request, stages: ['wiki-link', 'story'] })).toMatchObject({ ok: true, value: { attempts: [{ steps: [{ stage: 'wiki-link' }] }] } })
  expect((await deps.store.transaction(tx => tx.runs()))[0]).not.toHaveProperty('modelId')
})

test('a full-state selection is saved atomically as retryable chunks in one Batch', async () => {
  const { plate, deps } = setup()
  const plateIds = Array.from({ length: 990 }, (_, index) => `MD.${index}`)
  const scoped = { ...deps, /** Provide the baseline plate data used by the review or job scenario. */ baseline: async (id: string) => plateIds.includes(id) ? { ...plate, id, state: 'MD' } : null }
  const selection = { ...request, stages: ['wiki-link'] as const, plateIds }
  const { enqueueSelection } = await import('../../lib/jobs/queue')
  expect(await enqueueSelection(scoped, editor, { ...selection, stages: [...selection.stages], plateIds: [...plateIds.slice(0, -1), 'missing'] })).toEqual({ ok: false, error: 'not_found' })
  expect(await scoped.store.transaction(tx => tx.runs())).toEqual([])

  const initial = await enqueueSelection(scoped, editor, { ...selection, stages: [...selection.stages] })
  if (!initial.ok) throw Error(initial.error)
  expect(initial.value.length).toBeGreaterThan(1)
  expect(initial.value.flatMap(run => run.plateIds)).toEqual(plateIds)
  expect(initial.value.every(run => run.batchId === selection.batchId && run.incrementalDrafts && run.status === 'queued')).toBe(true)
  const duplicate = await enqueueSelection(scoped, editor, { ...selection, stages: [...selection.stages] })
  expect(duplicate.ok && duplicate.value.map(run => run.id)).toEqual(initial.value.map(run => run.id))
  expect(await enqueueSelection(scoped, editor, { ...selection, stages: ['tag'] })).toEqual({ ok: false, error: 'request_mismatch' })
})

test('an invalid request creates no draft and a valid mixed-state request creates one named draft', async () => {
  const { plate, deps, review } = setup()
  const newBatch = { name: 'Cross-state pipeline', baselineVersion: 1 }
  const input = { ...request, batchId: 'new-batch', plateIds: [plate.id, 'MD.two'], stages: ['wiki-link' as const] }
  const { enqueueSelection } = await import('../../lib/jobs/queue')
  expect(await enqueueSelection(deps, editor, input, newBatch)).toEqual({ ok: false, error: 'not_found' })
  expect(await review.getBatch('new-batch')).toBeNull()

  const scoped = { ...deps, /** Resolve the plate by ID from the fixture baseline. */ baseline: async (id: string) => id === 'MD.two' ? { ...plate, id, state: 'MD' } : deps.baseline(id) }
  expect(await enqueueSelection(scoped, editor, input, newBatch)).toMatchObject({ ok: true, value: [{ batchId: 'new-batch' }] })
  expect(await review.getBatch('new-batch')).toMatchObject({ name: newBatch.name, createdBy: editor.uid, plateIds: input.plateIds })
  expect(await review.getBatch('batch')).toMatchObject({ name: 'Queue', plateIds: [plate.id] })
  expect(await enqueueSelection(scoped, editor, input, newBatch)).toMatchObject({ ok: true })
})
