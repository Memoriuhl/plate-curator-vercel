import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { localJobsEnvironment } from '../../lib/jobs/local-scope'
import { claimJob, claimNext, getJob, reportResult } from '../../lib/jobs/jobs'
import { enqueueRun, cancelRun, listRuns, retryRun, maxQueueAttempts } from '../../lib/jobs/queue'
import { bindQueueWorkflow, dispatchQueueStage, observeQueueStage } from '../../lib/jobs/queue-engine'
import { failLocalJob } from '../../lib/jobs/queue-failure'
import type { JobsDeps, ReportInput } from '../../lib/jobs/types'
import type { LocalRunStage } from '../../lib/jobs/queue-types'

const actor = { uid: 'editor', role: 'editor' as const, name: null }
const other = { ...actor, uid: 'other' }
const owner = { ...actor, uid: 'owner', role: 'owner' as const }
const base = { backend: 'test', model: 'fixture', promptVersion: 'v1', durationMs: 10 }

function setup() {
  let time = 100, sequence = 0
  const plates = ['one', 'two'].map(slug => ({ id: `AK.${slug}`, state: 'AK', slug, displayName: slug, image: '', tags: [] }))
  const review = createMemoryStore(['batch', 'other-batch'].map((id, index) => ({ id, name: 'Queue', createdBy: index ? other.uid : actor.uid, createdAt: '', revision: 0,
    state: 'open' as const, baselineVersion: 1, plateIds: plates.map(plate => plate.id), approval: null })))
  const store = createMemoryJobsStore(review, localJobsEnvironment('test-queue'))
  const deps: JobsDeps = { store, localScope: 'test-queue', baseline: async id => plates.find(plate => plate.id === id) ?? null,
    now: () => time, id: () => `claim-${++sequence}`, leaseMs: 1000 }
  async function run(requestId = `request-${++sequence}`, stages: LocalRunStage[] = ['tag'], requestedBy = actor, batchId = 'batch') {
    const result = await enqueueRun(deps, requestedBy, { requestId, batchId, plateIds: [plates[0].id], stages })
    if (!result.ok) throw Error(result.error)
    expect(await bindQueueWorkflow(deps, result.value.id, 1, `workflow-${requestId}`)).toBe(true)
    await dispatchQueueStage(deps, result.value.id, 1, 0, `hook-${requestId}`)
    return result.value
  }
  async function complete(workerId: string, report: ReportInput = { ...base, suggestions: ['blue'] }) {
    const claim = await claimNext(deps, workerId)
    if (!claim) throw Error('Expected claim')
    const sent = await reportResult(deps, workerId, claim.job.id, claim.claimId, report)
    expect(sent).toMatchObject({ ok: true })
    await observeQueueStage(deps, claim.job.queueRunId!, claim.job.queueAttempt!, claim.job.queueStep!)
    return claim
  }
  return { deps, plates, review, run, complete, advance: (ms: number) => { time += ms } }
}

beforeEach(() => vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1'))
afterEach(() => vi.unstubAllEnvs())

test('transactional GPU bound holds across processes, queued jobs do not expire, by-id cannot bypass, production sees none', async () => {
  const s = setup()
  const first = await s.run('first')
  s.advance(1)
  await s.run('second')
  s.advance(20 * 60_000)
  const claims = await Promise.all([claimNext({ ...s.deps }, 'worker-one'), claimNext({ ...s.deps }, 'worker-two')])
  expect(claims.filter(Boolean)).toHaveLength(1)
  expect(claims.find(Boolean)?.job.queueRunId).toBe(first.id)
  expect(await claimJob(s.deps, 'bypass', `${first.id}-1-0`)).toMatchObject({ error: 'forbidden' })
  const legacy = { ...s.deps, localScope: undefined }
  expect(await claimNext(legacy, 'production')).toBeNull()
  expect((await getJob(s.deps, `${first.id}-1-0`))?.leaseExpiresAt).toBe(s.deps.now() + 10 * 60_000)
})

test('Colors and Tag compete for the same GPU slot while IO permits two workers', async () => {
  const s = setup()
  await s.run('colors', ['colors'])
  s.advance(1)
  await s.run('tag', ['tag'])
  const first = await claimNext(s.deps, 'worker')
  expect(first?.job.stage).toBe('colors')
  expect(await claimNext(s.deps, 'other')).toBeNull()
  await s.run('wiki-one', ['wiki-link'])
  await s.run('wiki-two', ['wiki-link'])
  await s.run('wiki-three', ['wiki-link'])
  expect(await claimNext(s.deps, 'io-one')).not.toBeNull()
  expect(await claimNext(s.deps, 'io-two')).not.toBeNull()
  expect(await claimNext(s.deps, 'io-three')).toBeNull()
})

test('round robin gives another requester a stage boundary while preserving same-user FIFO', async () => {
  const s = setup()
  const first = await s.run('editor-first')
  s.advance(1)
  const second = await s.run('editor-second')
  s.advance(1)
  const theirs = await s.run('other-first', ['tag'], other, 'other-batch')
  const a = await s.complete('worker')
  expect(a.job.queueRunId).toBe(first.id)
  const b = await s.complete('worker')
  expect(b.job.queueRunId).toBe(theirs.id)
  expect((await s.complete('worker')).job.queueRunId).toBe(second.id)
})

test('sequential projected Wiki/Describe/Story survives server reconstruction and missed callback, never writes Batch', async () => {
  const s = setup()
  const run = await s.run('chain', ['wiki-link', 'describe', 'story'])
  const wiki = await s.complete('worker', { ...base, fieldSuggestion: { stage: 'wiki-link', fields: { wikiUrl: 'https://example.org/wiki' }, sources: ['https://example.org/wiki'] } })
  await dispatchQueueStage({ ...s.deps }, run.id, 1, 1, 'description-hook')
  const describe = await claimNext(s.deps, 'worker')
  expect(describe?.job.inputPlate?.wikiUrl).toBe('https://example.org/wiki')
  expect(describe?.job.inputHash).toBe(wiki.job.inputHash)
  expect(describe?.job.executionHash).not.toBe(wiki.job.inputHash)
  await reportResult(s.deps, 'worker', describe!.job.id, describe!.claimId, { ...base,
    fieldSuggestion: { stage: 'describe', fields: { description: 'Sourced' }, sources: ['https://example.org/wiki'] } })
  expect(await observeQueueStage({ ...s.deps }, run.id, 1, 1)).toEqual({ phase: 'next' })
  await dispatchQueueStage(s.deps, run.id, 1, 2, 'story-hook')
  expect((await claimNext(s.deps, 'worker'))?.job.inputPlate?.description).toBe('Sourced')
  expect(await s.review.listEdits('batch')).toEqual([])
})

test('no-result and explicit handler failure stop all downstream dependencies', async () => {
  for (const noResult of [true, false]) {
    const s = setup()
    const run = await s.run('failure', ['describe', 'story'])
    const claim = (await claimNext(s.deps, 'worker'))!
    if (noResult) await reportResult(s.deps, 'worker', claim.job.id, claim.claimId, { ...base, stageError: 'no_sources' })
    else await failLocalJob(s.deps, 'worker', claim.job.id, claim.claimId, 'no_handler')
    expect(await observeQueueStage(s.deps, run.id, 1, 0)).toEqual({ phase: 'done' })
    expect(await dispatchQueueStage(s.deps, run.id, 1, 1, 'never')).toBeNull()
    const saved = (await s.deps.store.transaction(tx => tx.runs()))[0]
    expect(saved.status).toBe('failed')
    expect(saved.attempts[0].outcome).toBe(noResult ? 'no_result' : undefined)
    expect(saved.attempts[0].jobIds).toHaveLength(1)
  }
})

test('cancellation is immediate before claim but remains requested until active worker acknowledges safe end', async () => {
  const s = setup()
  const queued = await s.run('queued')
  expect(await cancelRun(s.deps, actor, queued.id)).toMatchObject({ value: { status: 'cancelled' } })
  expect(await claimNext(s.deps, 'worker')).toBeNull()
  const active = await s.run('active', ['tag', 'story'])
  const claim = (await claimNext(s.deps, 'worker'))!
  expect(await cancelRun(s.deps, actor, active.id)).toMatchObject({ value: { status: 'running', cancelRequestedAt: 100 } })
  s.advance(11 * 60_000)
  expect(await observeQueueStage(s.deps, active.id, 1, 0)).toEqual({ phase: 'waiting' })
  await s.run('waiting')
  expect(await claimNext(s.deps, 'second')).toBeNull()
  expect(await retryRun(s.deps, actor, active.id, 'too-soon')).toMatchObject({ error: 'invalid_state' })
  await failLocalJob(s.deps, 'worker', claim.job.id, claim.claimId, 'lease_expired')
  await observeQueueStage(s.deps, active.id, 1, 0)
  expect((await s.deps.store.transaction(tx => tx.runs())).find(run => run.id === active.id)?.status).toBe('cancelled')
  expect(await claimNext(s.deps, 'second')).not.toBeNull()
})

test('retry preserves completed result provenance, deduplicates command, rejects changed Batch and bounds attempt growth', async () => {
  const s = setup()
  const run = await s.run('retry', ['describe', 'story'])
  const done = await s.complete('worker', { ...base, fieldSuggestion: { stage: 'describe', fields: { description: 'Sourced' }, sources: ['https://example.org/wiki'] } })
  await dispatchQueueStage(s.deps, run.id, 1, 1, 'story')
  const failed = (await claimNext(s.deps, 'worker'))!
  await failLocalJob(s.deps, 'worker', failed.job.id, failed.claimId, 'stage_failed')
  await observeQueueStage(s.deps, run.id, 1, 1)
  const retry = await retryRun(s.deps, actor, run.id, 'retry-command')
  expect(retry).toMatchObject({ value: { attempts: [{ number: 1, status: 'failed' }, { number: 2, cursor: 1, completedJobIds: [done.job.id] }] } })
  expect(await retryRun(s.deps, actor, run.id, 'retry-command')).toEqual(retry)
  await cancelRun(s.deps, actor, run.id)
  const batch = (await s.review.getBatch('batch'))!
  await s.review.commit('batch', batch.revision, { batch: { ...batch, baselineVersion: 2, revision: batch.revision + 1 } })
  expect(await retryRun(s.deps, actor, run.id, 'changed')).toMatchObject({ error: 'stale_input' })
  await s.deps.store.transaction(async tx => { const [saved] = await tx.runs(); saved.attempts = Array.from({ length: maxQueueAttempts }, () => saved.attempts[0]); tx.setRun(saved) })
  expect(await retryRun(s.deps, actor, run.id, 'overflow')).toMatchObject({ error: 'attempt_limit' })
})

test('list/cancel/retry enforce requester/Batch ownership and read-only mutations even for Owner', async () => {
  const s = setup()
  const run = await s.run('private')
  expect(await listRuns(s.deps, other)).toEqual({ ok: true, value: [] })
  expect(await listRuns(s.deps, owner)).toMatchObject({ ok: true, value: [{ id: run.id }] })
  expect(await cancelRun(s.deps, other, run.id)).toMatchObject({ error: 'forbidden' })
  expect(await retryRun(s.deps, other, run.id, 'retry')).toMatchObject({ error: 'forbidden' })
  const batch = (await s.review.getBatch('batch'))!
  await s.review.commit('batch', 0, { batch: { ...batch, revision: 1, state: 'submitted' } })
  expect(await cancelRun(s.deps, owner, run.id)).toMatchObject({ error: 'invalid_state' })
})

test('unknown, retired and hosted model choices fail before any durable write; oversized snapshot fails honestly', async () => {
  const s = setup()
  const input = { requestId: 'model', batchId: 'batch', plateIds: ['AK.one'], stages: ['tag' as const] }
  expect(await enqueueRun(s.deps, actor, { ...input, modelId: 'invented' })).toMatchObject({ error: 'bad_request' })
  expect(await enqueueRun(s.deps, actor, { ...input, modelId: 'gateway-gemma4-26b' })).toMatchObject({ error: 'invalid_state' })
  vi.stubEnv('TAGGING_MODELS', 'desktop-gemma4-12b')
  expect(await enqueueRun(s.deps, actor, { ...input, modelId: 'desktop-gemma4-26b' })).toMatchObject({ error: 'invalid_state' })
  const big = { ...s.deps, baseline: async () => ({ ...s.plates[0], description: 'x'.repeat(400_000) }) }
  expect(await enqueueRun(big, actor, input)).toMatchObject({ error: 'payload_too_large' })
  expect(await s.deps.store.transaction(tx => tx.runs())).toEqual([])
})
