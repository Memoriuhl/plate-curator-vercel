import { expect, test, vi } from 'vitest'
import type { Plate } from '../../lib/catalog/types'
import { createJob, claimNext, getJob, reportResult } from '../../lib/jobs/jobs'
import { issueWorkerToken, verifyWorkerToken, revokeWorkerToken } from '../../lib/jobs/tokens'
import type { JobsDeps, JobsStore, JobsTransaction } from '../../lib/jobs/types'
import { plateRevision } from '../../lib/review/revision'
import type { ReviewStore } from '../../lib/review/types'

export function jobsScenarios(make: () => Promise<{ store: JobsStore; review: ReviewStore; other: JobsStore }>) {
  async function setup() {
    const stores = await make()
    await stores.review.create({ id: 'batch', name: 'Batch', createdBy: 'owner', createdAt: '2026-11-15T12:00:00Z', state: 'open', revision: 0, baselineVersion: 1, plateIds: ['one', 'two'], approval: null })
    let time = 1000
    let sequence = 0
    const plate: Plate = { id: 'one', state: 'CA', slug: 'one', displayName: 'One', image: 'one.png', tags: [] }
    const deps: JobsDeps = { store: stores.store, baseline: async id => ({ ...plate, id }), now: () => time, id: () => `id-${++sequence}`, leaseMs: 100 }
    async function create(id = 'job') { return createJob(deps, { id, batchId: 'batch', plateId: 'one' }) }
    async function claim() {
      const claimed = await claimNext(deps, 'worker')
      if (!claimed) throw new Error('Expected claim')
      return claimed
    }
    const result = { suggestions: [' Blue ', 'blue', ''], backend: 'local', model: 'model', promptVersion: 'v1', durationMs: 10, usage: { tokens: 4 } }
    return { ...stores, deps, plate, create, claim, result, advance: (value: number) => { time += value } }
  }

  test('claims the oldest queued job with a lease', async () => {
    const s = await setup()
    await s.create('first')
    s.advance(1)
    await s.create('second')
    expect(await s.claim()).toMatchObject({ job: { id: 'first', inputHash: plateRevision(s.plate), env: 'development', state: 'claimed' }, claimId: 'id-1', leaseExpiresAt: 1101 })
    expect(await s.claim()).toMatchObject({ job: { id: 'second' } })
  })
  test('nothing queued returns null', async () => {
    const s = await setup()
    expect(await claimNext(s.deps, 'worker')).toBeNull()
  })
  test('an expired lease returns the job to the queue', async () => {
    const s = await setup()
    await s.create()
    const first = await s.claim()
    s.advance(100)
    const second = await s.claim()
    expect(second.job.id).toBe(first.job.id)
    expect(second.claimId).not.toBe(first.claimId)
    expect(await reportResult(s.deps, 'worker', 'job', first.claimId, s.result)).toEqual({ ok: false, error: 'claim_mismatch' })
  })
  test('report with a wrong claim id is refused', async () => {
    const s = await setup()
    await s.create()
    await s.claim()
    expect(await reportResult(s.deps, 'worker', 'job', 'wrong', s.result)).toEqual({ ok: false, error: 'claim_mismatch' })
  })
  test('report after lease expiry is refused', async () => {
    const s = await setup()
    await s.create()
    const c = await s.claim()
    s.advance(100)
    expect(await reportResult(s.deps, 'worker', 'job', c.claimId, s.result)).toEqual({ ok: false, error: 'claim_expired' })
  })
  test('report for a plate whose revision changed is refused as stale_input', async () => {
    const s = await setup()
    await s.create()
    const c = await s.claim()
    const batch = await s.review.getBatch('batch')
    await s.review.commit('batch', 0, { batch: { ...batch!, revision: 1 }, edit: { plateId: 'one', baseRevision: plateRevision(s.plate), fields: { tags: ['edited'] }, authorId: 'owner', updatedAt: 'now', resultRevision: 'changed' } })
    expect(await reportResult(s.deps, 'worker', 'job', c.claimId, s.result)).toEqual({ ok: false, error: 'stale_input' })
  })
  test('editing a different plate does not invalidate a report', async () => {
    const s = await setup()
    await s.create()
    const c = await s.claim()
    const batch = await s.review.getBatch('batch')
    await s.review.commit('batch', 0, { batch: { ...batch!, revision: 1 }, edit: { plateId: 'two', baseRevision: 'before', fields: { tags: ['edited'] }, authorId: 'owner', updatedAt: 'now', resultRevision: 'changed' } })
    expect(await reportResult(s.deps, 'worker', 'job', c.claimId, s.result)).toMatchObject({ ok: true })
  })
  test('a repeated identical report is acknowledged without a second write', async () => {
    const s = await setup()
    await s.create()
    const c = await s.claim()
    const first = await reportResult(s.deps, 'worker', 'job', c.claimId, s.result)
    const write = vi.fn()
    const transaction = s.store.transaction.bind(s.store)
    const spy = vi.spyOn(s.store, 'transaction').mockImplementation(run => transaction(tx => run({
      ...tx, set(job) { write(job); tx.set(job) },
    } as JobsTransaction)))
    s.advance(200)
    expect(await reportResult(s.deps, 'worker', 'job', c.claimId, s.result)).toEqual(first)
    expect(await getJob(s.deps, 'job')).toMatchObject({ completedAt: 1000, result: { suggestions: ['blue'] } })
    expect(write).not.toHaveBeenCalled()
    spy.mockRestore()
  })
  test('suggestions are normalized, deduplicated and capped', async () => {
    const s = await setup()
    await s.create()
    const c = await s.claim()
    const suggestions = [null, 4, {}, '', ' ', 'x'.repeat(61), ' BLUE ', 'blue', ...Array.from({ length: 30 }, (_, i) => `Tag ${i}`)]
    await reportResult(s.deps, 'worker', 'job', c.claimId, { ...s.result, suggestions })
    expect((await getJob(s.deps, 'job'))?.result?.suggestions).toEqual(['blue', ...Array.from({ length: 19 }, (_, i) => `tag ${i}`)])
  })
  test('zero valid suggestions are accepted', async () => {
    const s = await setup()
    await s.create()
    const c = await s.claim()
    expect(await reportResult(s.deps, 'worker', 'job', c.claimId, { ...s.result, suggestions: [null, ''] })).toMatchObject({ ok: true, value: { result: { suggestions: [] } } })
  })
  test('worker token verifies, and a revoked token does not', async () => {
    const s = await setup()
    const owner = { uid: 'owner', role: 'owner' } as const
    const issued = await issueWorkerToken(s.deps, owner, 'worker')
    if (!issued.ok) throw new Error('Expected token')
    expect(await verifyWorkerToken(s.deps, issued.value.token)).toBe('worker')
    const stored = await s.store.getToken(issued.value.hash)
    expect(stored).toMatchObject({ hash: issued.value.hash, workerId: 'worker', env: 'development', revokedAt: null })
    expect(JSON.stringify(stored)).not.toContain(issued.value.token)
    expect(await revokeWorkerToken(s.deps, { uid: 'editor', role: 'editor' }, issued.value.hash)).toEqual({ ok: false, error: 'forbidden' })
    await revokeWorkerToken({ ...s.deps, store: s.other }, owner, issued.value.hash)
    expect(await verifyWorkerToken(s.deps, issued.value.token)).toBe('worker')
    expect(await verifyWorkerToken({ ...s.deps, store: s.other }, issued.value.token)).toBeNull()
    expect(await verifyWorkerToken(s.deps, 'invalid')).toBeNull()
    expect(await revokeWorkerToken(s.deps, owner, issued.value.hash)).toEqual({ ok: true, value: null })
    expect(await verifyWorkerToken(s.deps, issued.value.token)).toBeNull()
    expect(await issueWorkerToken(s.deps, { uid: 'editor', role: 'editor' }, 'worker')).toEqual({ ok: false, error: 'forbidden' })
  })
  test('jobs from another environment are invisible to claims', async () => {
    const s = await setup()
    await s.create()
    expect(await claimNext({ ...s.deps, store: s.other }, 'worker')).toBeNull()
    expect(await getJob({ ...s.deps, store: s.other }, 'job')).toBeNull()
    expect(await createJob({ ...s.deps, store: s.other }, { id: 'other-job', batchId: 'batch', plateId: 'one' })).toEqual({ ok: false, error: 'not_found' })
  })
  test('two concurrent claims never return the same job', async () => {
    const s = await setup()
    await s.create()
    const results = await Promise.all([claimNext(s.deps, 'one'), claimNext(s.deps, 'two')])
    expect(results.filter(Boolean)).toHaveLength(1)
  })
  test('changed reports and another worker cannot overwrite accepted results', async () => {
    const s = await setup()
    await s.create()
    const c = await s.claim()
    await reportResult(s.deps, 'worker', 'job', c.claimId, s.result)
    expect(await reportResult(s.deps, 'other', 'job', c.claimId, s.result)).toEqual({ ok: false, error: 'claim_mismatch' })
    expect(await reportResult(s.deps, 'worker', 'job', c.claimId, { ...s.result, model: 'changed' })).toEqual({ ok: false, error: 'result_mismatch' })
  })
  test('missing batches and plates cannot create jobs', async () => {
    const s = await setup()
    expect(await createJob(s.deps, { id: 'missing', batchId: 'missing', plateId: 'one' })).toEqual({ ok: false, error: 'not_found' })
    expect(await createJob(s.deps, { id: 'missing', batchId: 'batch', plateId: 'missing' })).toEqual({ ok: false, error: 'not_found' })
    expect(await s.create()).toMatchObject({ ok: true })
    expect(await s.create()).toEqual({ ok: false, error: 'already_exists' })
  })
  test('creation uses the proposed plate revision', async () => {
    const s = await setup()
    const batch = await s.review.getBatch('batch')
    await s.review.commit('batch', 0, { batch: { ...batch!, revision: 1 }, edit: { plateId: 'one', baseRevision: plateRevision(s.plate), fields: { tags: ['edited'] }, authorId: 'owner', updatedAt: 'now', resultRevision: 'changed' } })
    expect(await s.create()).toMatchObject({ ok: true, value: { inputHash: plateRevision({ ...s.plate, tags: ['edited'] }) } })
  })
  test.each([null, {}, 'blue'])('invalid suggestions container is refused: %j', async suggestions => {
    const s = await setup()
    await s.create()
    const c = await s.claim()
    expect(await reportResult(s.deps, 'worker', 'job', c.claimId, { ...s.result, suggestions })).toEqual({ ok: false, error: 'invalid_result' })
    expect(await getJob(s.deps, 'job')).toMatchObject({ state: 'claimed' })
  })
  test('report metadata survives persistence and reordered usage is idempotent', async () => {
    const s = await setup()
    await s.create()
    const c = await s.claim()
    const input = { ...s.result, usage: { input: 3, output: 4 } }
    const first = await reportResult(s.deps, 'worker', 'job', c.claimId, input)
    expect(first).toMatchObject({ ok: true, value: { result: { backend: input.backend, model: input.model, promptVersion: input.promptVersion, durationMs: 10, usage: input.usage } } })
    expect(await reportResult(s.deps, 'worker', 'job', c.claimId, { ...input, usage: { output: 4, input: 3 } })).toEqual(first)
  })
}
