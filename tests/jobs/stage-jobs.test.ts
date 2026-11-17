import { afterEach, expect, test, vi } from 'vitest'
import { createJob, claimJob, claimNext, getJob, reportResult } from '../../lib/jobs/jobs'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { localJobsEnvironment, localPipelineScope } from '../../lib/jobs/local-scope'
import type { JobsDeps, PipelineStage } from '../../lib/jobs/types'
import { assertLocalWorker } from '../../worker/local'
import { proposeEdit } from '../../lib/review/batch'
import { plateRevision } from '../../lib/review/revision'

afterEach(() => vi.unstubAllEnvs())

function setup() {
  let sequence = 0
  const plate = { id: 'AK.one', state: 'AK', slug: 'one', displayName: 'One', image: '', tags: [], description: 'Original description' }
  const review = createMemoryStore([{ id: 'batch', name: 'Stage', createdBy: 'editor', createdAt: '', revision: 0, state: 'open', baselineVersion: 1, plateIds: [plate.id], approval: null }])
  const jobs: JobsDeps = { store: createMemoryJobsStore(review, 'development'), baseline: async () => plate, now: () => 100, id: () => `claim-${++sequence}`, leaseMs: 1000 }
  const local = { ...jobs, localScope: 'scope-a' }
  const input = { id: 'stage', batchId: 'batch', plateId: plate.id, requestedBy: 'editor', stage: 'describe' as const }
  const report = { fieldSuggestion: { kind: 'fields' as const, stage: 'describe', fields: { description: 'Sourced description' }, sources: ['https://example.org/source'] }, backend: 'local', model: 'test', promptVersion: 'v1', durationMs: 10 }
  return { jobs, local, input, report, review, plate }
}

test('new stage jobs require opt-in and a local queue scope', async () => {
  const s = setup()
  expect(await createJob(s.local, s.input)).toEqual({ ok: false, error: 'forbidden' })
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  expect(await createJob(s.jobs, s.input)).toEqual({ ok: false, error: 'forbidden' })
  expect(await createJob(s.local, { ...s.input, stage: '' as PipelineStage })).toEqual({ ok: false, error: 'forbidden' })
  expect(await createJob(s.local, s.input)).toMatchObject({ ok: true, value: { stage: 'describe', localScope: 'scope-a' } })
})

test('local workers cannot claim unrelated local or unscoped jobs, and legacy workers skip local jobs', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const s = setup()
  await createJob(s.jobs, { ...s.input, id: 'legacy', stage: undefined })
  await createJob(s.local, s.input)
  const other = { ...s.jobs, localScope: 'scope-b' }
  await createJob(other, { ...s.input, id: 'other' })
  expect(await claimNext(s.jobs, 'legacy-worker')).toMatchObject({ job: { id: 'legacy' } })
  expect(await claimNext(s.jobs, 'legacy-worker')).toBeNull()
  expect(await claimNext(s.local, 'local-worker')).toMatchObject({ job: { id: 'stage' } })
  expect(await claimNext(s.local, 'local-worker')).toBeNull()
  expect(await claimJob(s.local, 'local-worker', 'other')).toEqual({ ok: false, error: 'forbidden' })
  expect(await claimNext(other, 'other-worker')).toMatchObject({ job: { id: 'other' } })
})

test('field reports are stage checked, idempotent and leave the Batch unchanged until accepted', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const s = setup()
  await createJob(s.local, s.input)
  const claim = await claimNext(s.local, 'worker')
  if (!claim) throw Error('Expected claim')
  const send = (report = s.report) => reportResult(s.local, 'worker', s.input.id, claim.claimId, report)
  expect(await send({ ...s.report, fieldSuggestion: { ...s.report.fieldSuggestion, stage: 'story' } })).toMatchObject({ error: 'invalid_result' })
  expect(await send()).toMatchObject({ ok: true, value: { state: 'completed', result: { suggestions: [], fieldSuggestion: s.report.fieldSuggestion } } })
  expect(await send()).toMatchObject({ ok: true })
  expect(await send({ ...s.report, fieldSuggestion: { ...s.report.fieldSuggestion, fields: { description: 'Different' } } })).toMatchObject({ error: 'result_mismatch' })
  expect(await s.review.listEdits('batch')).toEqual([])
  expect((await s.review.getBatch('batch'))?.revision).toBe(0)
  expect((await getJob(s.local, s.input.id))?.result?.fieldSuggestion).toMatchObject({ kind: 'fields', fields: { description: 'Sourced description' } })
})

test('reports retain stale input and scope guards', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const s = setup()
  await createJob(s.local, s.input)
  const claim = await claimNext(s.local, 'worker')
  if (!claim) throw Error('Expected claim')
  expect(await reportResult(s.jobs, 'worker', s.input.id, claim.claimId, s.report)).toMatchObject({ error: 'forbidden' })
  s.local.baseline = async () => ({ id: 'AK.one', state: 'AK', slug: 'one', displayName: 'Changed', tags: [], image: '' })
  expect(await reportResult(s.local, 'worker', s.input.id, claim.claimId, s.report)).toMatchObject({ error: 'stale_input' })
})

test('the local server fails closed without its dedicated scope and ignores it when the flag is off', () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  vi.stubEnv('LOCAL_PIPELINE_SCOPE', 'unrelated')
  expect(localPipelineScope()).toBeUndefined()
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  vi.stubEnv('LOCAL_PIPELINE_SCOPE', '')
  expect(() => localPipelineScope()).toThrow('LOCAL_PIPELINE_SCOPE')
  vi.stubEnv('LOCAL_PIPELINE_SCOPE', 'scope-a')
  expect(localPipelineScope()).toBe('scope-a')
})

test('local workers enforce localhost and concurrency 1 before polling', () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  vi.stubEnv('LOCAL_PIPELINE_SCOPE', 'scope-a')
  expect(() => assertLocalWorker('http://localhost:3301', 1)).not.toThrow()
  expect(() => assertLocalWorker('http://localhost:3301', 2)).toThrow('concurrency 1')
  expect(() => assertLocalWorker('https://example.org', 1)).toThrow('localhost')
})

test('legacy workers cannot even see jobs isolated in a local environment', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const s = setup()
  const shared = createMemoryJobsStore(s.review, 'development')
  const isolated = shared.forEnvironment(localJobsEnvironment('scope-a'), s.review)
  await createJob({ ...s.local, store: isolated }, s.input)
  expect(await claimNext({ ...s.jobs, store: shared }, 'older-worker')).toBeNull()
  expect(await getJob({ ...s.jobs, store: shared }, s.input.id)).toBeNull()
  expect(await claimNext({ ...s.local, store: isolated }, 'local-worker')).toMatchObject({ job: { id: s.input.id, env: localJobsEnvironment('scope-a') } })
})

test('accepting a completed field result edits only the Batch, with a stale guard and reversible cleanup', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const s = setup()
  await createJob(s.local, s.input)
  const claimed = await claimNext(s.local, 'worker')
  if (!claimed) throw Error('Expected claim')
  await reportResult(s.local, 'worker', s.input.id, claimed.claimId, s.report)
  const job = await getJob(s.local, s.input.id)
  const deps = { store: s.review, baseline: async () => s.plate, baselineAtVersion: async () => s.plate, stateBaseline: async () => [s.plate], now: () => '' }
  const actor = { uid: 'editor', name: null, role: 'editor' as const }
  const suggestion = job!.result!.fieldSuggestion!
  if (suggestion.kind !== 'fields') throw Error('Expected fields')
  const input = { batchId: 'batch', plateId: s.plate.id, baseRevision: job!.inputHash, fields: suggestion.fields }
  const saved = await proposeEdit(deps, actor, input)
  expect(saved).toMatchObject({ ok: true })
  expect(s.plate.description).toBe('Original description')
  expect((await s.review.getEdit('batch', s.plate.id))?.fields).toEqual({ description: 'Sourced description' })
  expect(await proposeEdit(deps, actor, input)).toMatchObject({ error: 'stale_plate' })
  if (!saved.ok) return
  expect(await proposeEdit(deps, actor, { ...input, baseRevision: plateRevision(saved.value.plate), fields: { description: s.plate.description } })).toMatchObject({ ok: true })
  expect(await s.review.listEdits('batch')).toEqual([])
})

test('a sourced stage can complete without an acceptable suggestion and never writes a draft', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const s = setup()
  await createJob(s.local, s.input)
  const claim = await claimNext(s.local, 'worker')
  if (!claim) throw Error('Expected claim')
  const report = { backend: 'ollama', model: 'test', promptVersion: 'v1', durationMs: 10, stageError: 'no_supported_fields' }
  expect(await reportResult(s.local, 'worker', s.input.id, claim.claimId, report)).toMatchObject({ ok: true, value: { state: 'completed', result: { stageError: 'no_supported_fields', suggestions: [] } } })
  expect(await s.review.listEdits('batch')).toEqual([])
})
