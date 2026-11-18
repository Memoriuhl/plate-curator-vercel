import { expect, test } from 'vitest'
import {
  claimResearch,
  renewResearchClaim,
  reportResearch,
} from '../../lib/research/jobs'
import { proposeEdit } from '../../lib/review/batch'
import { plateRevision } from '../../lib/review/revision'
import { researchFixture } from './fixture'

test('duplicate starts retain executor and identity rather than launching duplicate jobs', async () => {
  const f = researchFixture()
  const [a, b] = await Promise.all([f.start(), f.start()])
  expect(a).toMatchObject({
    ok: true,
    value: { executor: 'desktop', state: 'queued' },
  })
  expect(b).toEqual(a)
  expect(await f.start('request', 'eve')).toEqual({
    ok: false,
    error: 'request_mismatch',
  })
})

test('explicit replacement fences a running desktop result', async () => {
  const f = researchFixture()
  const first = await f.start()
  if (!first.ok) throw new Error('setup')
  const claim = await claimResearch(f.deps, 'desktop')
  const replacement = await f.start('replacement', 'eve', first.value.id)
  expect(replacement).toMatchObject({ ok: true, value: { executor: 'eve' } })
  expect(
    await reportResearch(f.deps, 'desktop', {
      jobId: first.value.id,
      claimId: claim!.claimId,
      result: f.result(first.value),
    })
  ).toEqual({ ok: false, error: 'superseded' })
})

test('renewal protects active work while an expired claim cannot report after takeover', async () => {
  const f = researchFixture()
  await f.start()
  const first = await claimResearch(f.deps, 'first')
  f.advance(299000)
  expect(
    await renewResearchClaim(f.deps, 'first', {
      jobId: first!.job.id,
      claimId: first!.claimId,
    })
  ).toMatchObject({ ok: true })
  expect(await claimResearch(f.deps, 'second')).toBeNull()
  f.advance(301000)
  const second = await claimResearch(f.deps, 'second')
  expect(second!.claimId).not.toBe(first!.claimId)
  expect(
    await reportResearch(f.deps, 'first', {
      jobId: first!.job.id,
      claimId: first!.claimId,
      result: f.result(first!.job),
    })
  ).toMatchObject({ ok: false, error: 'claim_mismatch' })
})

test('edits after dispatch refuse stale results and duplicate reports settle once', async () => {
  const f = researchFixture()
  await f.start()
  const claim = await claimResearch(f.deps, 'desktop')
  const result = f.result(claim!.job)
  expect(
    await reportResearch(f.deps, 'desktop', {
      jobId: claim!.job.id,
      claimId: claim!.claimId,
      result,
    })
  ).toMatchObject({ ok: true, value: { state: 'completed' } })
  expect(
    await reportResearch(f.deps, 'desktop', {
      jobId: claim!.job.id,
      claimId: claim!.claimId,
      result,
    })
  ).toMatchObject({ ok: true })
  await f.start('second')
  const second = await claimResearch(f.deps, 'desktop')
  await proposeEdit(f.review, f.owner, {
    batchId: 'batch',
    plateId: f.plate.id,
    baseRevision: plateRevision(f.plate),
    fields: { description: 'A changed description' },
  })
  expect(
    await reportResearch(f.deps, 'desktop', {
      jobId: second!.job.id,
      claimId: second!.claimId,
      result: f.result(second!.job),
    })
  ).toEqual({ ok: false, error: 'stale_input' })
})

test('removed requesters and cross-environment workers cannot receive new work', async () => {
  const f = researchFixture()
  await f.start()
  expect(
    await claimResearch(
      { ...f.deps, store: f.store.forEnvironment('production') },
      'worker'
    )
  ).toBeNull()
  f.remove()
  expect(await f.start('again')).toMatchObject({
    ok: false,
    error: 'forbidden',
  })
  expect(await claimResearch(f.deps, 'worker')).toBeNull()
})

test('a failed synthesis remains a visible failure and retains screening reasons', async () => {
  const f = researchFixture()
  await f.start()
  const claim = (await claimResearch(f.deps, 'desktop'))!
  const result = {
    ...f.result(claim.job),
    status: 'failed' as const,
    rejected: [{ field: 'description' as const, reason: 'unsupported_claim' }],
  }
  expect(
    await reportResearch(f.deps, 'desktop', {
      jobId: claim.job.id,
      claimId: claim.claimId,
      result,
    })
  ).toMatchObject({
    ok: true,
    value: {
      state: 'failed',
      error: 'research_failed',
      result: { status: 'failed', rejected: result.rejected },
    },
  })
})
