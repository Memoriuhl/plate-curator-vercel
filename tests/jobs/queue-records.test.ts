import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { localJobsEnvironment } from '../../lib/jobs/local-scope'
import { enqueueRun, parseEnqueue } from '../../lib/jobs/queue'
import { parsePipelineOptions } from '../../lib/jobs/pipeline-options'
import type { JobsDeps } from '../../lib/jobs/types'

const editor = { uid: 'editor', role: 'editor' as const, name: null }
const other = { ...editor, uid: 'other' }
const owner = { ...editor, uid: 'owner', role: 'owner' as const }
const input = { requestId: 'request-one', batchId: 'batch', plateIds: ['AK.one'], stages: ['describe', 'story', 'tag'] as const }
const request = { ...input, stages: [...input.stages] }

function setup() {
  const plate = { id: 'AK.one', state: 'AK', slug: 'one', displayName: 'One', image: '', tags: [] }
  const review = createMemoryStore([{ id: 'batch', name: 'Queue', createdBy: editor.uid, createdAt: '', revision: 0, state: 'open', baselineVersion: 1, plateIds: [plate.id], approval: null }])
  const store = createMemoryJobsStore(review, localJobsEnvironment('test-queue'))
  const deps: JobsDeps = { store, localScope: 'test-queue', baseline: async id => id === plate.id ? plate : null,
    now: () => 100, id: () => 'claim', leaseMs: 1000 }
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
  const deps = { ...s.deps, baseline: async () => ({ ...s.plate, funFacts: [{ text: 'Already accepted', sourceUrl: 'https://example.org/source' }] }) }
  const result = await enqueueRun(deps, editor, { ...request, stages: ['story', 'describe'] })
  expect(result).toMatchObject({ ok: true, value: { options: { story: { redoExisting: false } }, attempts: [{ steps: [{ stage: 'describe' }] }] } })
  const redo = await enqueueRun(deps, editor, { ...request, requestId: 'explicit-redo', stages: ['story', 'describe'], options: { story: { redoExisting: true } } })
  expect(redo).toMatchObject({ ok: true, value: { options: { story: { redoExisting: true } }, attempts: [{ steps: [{ stage: 'describe' }, { stage: 'story' }] }] } })
})
