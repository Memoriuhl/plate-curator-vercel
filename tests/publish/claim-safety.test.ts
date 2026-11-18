import { expect, test, vi } from 'vitest'
import { resolveClaimRun, retryEligibility, type EligibilityInput } from '../../lib/publish/eligibility'
import { uploadError } from '../../lib/publish/upload'
import { batch, command } from './fixture'
import type { PublishRecord } from '../../lib/publish/types'

const old = { ...command, commandId: 'old-claim' }
const fresh = { ...command, commandId: 'fresh-claim' }
const input: EligibilityInput = {
  command: fresh, batch, control: { paused: false, generation: 1, changedBy: { uid: 'owner', email: 'owner@example.com' }, changedAt: '2026-11-15T12:00:00Z' },
  member: { uid: 'owner', role: 'owner', status: 'active', authorityEpoch: 0 }, liveVersion: 1, receipt: null,
  claim: { command: old, acceptedAt: '2026-11-15T12:00:00Z' }, now: '2026-11-15T12:10:00Z',
}

test('A: token lookup makes a healthy never-bound claim live beyond TTL', async () => {
  const findRun = vi.fn(async () => ({ runId: 'healthy', status: 'running' }))
  const resolved = await resolveClaimRun(input.claim, { findRun })
  expect(findRun).toHaveBeenCalledExactlyOnceWith('old-claim')
  expect(resolved.recoveredRunId).toBe('healthy')
  expect(retryEligibility({ ...input, claim: resolved.claim, runStatus: resolved.status })).toMatchObject({ canRetry: false, reason: 'locked' })
})

test('B3/C: replacing the expired claim makes a competing stale eligibility input locked', async () => {
  const resolved = await resolveClaimRun(input.claim, { findRun: async () => null })
  expect(retryEligibility({ ...input, claim: resolved.claim, runStatus: resolved.status })).toMatchObject({ canRetry: true })
  expect(retryEligibility({ ...input, command: { ...fresh, commandId: 'loser' }, claim: { command: fresh, acceptedAt: input.now } })).toMatchObject({ canRetry: false, reason: 'locked' })
})

test('A: a missing token lookup cannot authorize TTL takeover', async () => {
  const resolved = await resolveClaimRun(input.claim, {})
  expect(retryEligibility({ ...input, claim: resolved.claim, runStatus: resolved.status })).toMatchObject({ canRetry: false, reason: 'locked' })
})

test('a bound run explicitly reported not found permits takeover after the claim TTL', async () => {
  const resolved = await resolveClaimRun({ ...input.claim!, runId: 'purged-run' }, { runStatus: async () => 'not_found' })
  expect(retryEligibility({ ...input, claim: resolved.claim, runStatus: resolved.status })).toMatchObject({ canRetry: true })
})

test('a transient run lookup stays locked and recovers when the next lookup works', async () => {
  const lookup = { runStatus: vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce('completed') }
  const claim = { ...input.claim!, runId: 'recoverable-run' }
  const first = await resolveClaimRun(claim, lookup)
  expect(retryEligibility({ ...input, claim: first.claim, runStatus: first.status })).toMatchObject({ canRetry: false, reason: 'locked' })
  const second = await resolveClaimRun(claim, lookup)
  expect(retryEligibility({ ...input, claim: second.claim, runStatus: second.status })).toMatchObject({ canRetry: true })
})

test.each(['failed', 'cancelled', 'completed'])('B2: terminal %s permits takeover while a live bound run stays locked', runStatus => {
  expect(retryEligibility({ ...input, claim: { ...input.claim!, runId: 'old-run' }, runStatus })).toMatchObject({ canRetry: true })
  expect(retryEligibility({ ...input, claim: { ...input.claim!, runId: 'old-run' }, runStatus: 'running' })).toMatchObject({ canRetry: false, reason: 'locked' })
})

const prepared: PublishRecord = { id: 'batch@2', ...command, fromVersion: 1, toVersion: 2, blobSha256: 'same-bytes', state: 'started' }

test.each(['owner', 'batch', 'revision', 'version', 'committed', 'other-commit', 'checksum', 'pointer'])('D: before-upload proof refuses %s', changed => {
  const saved = { ...prepared }
  if (changed === 'owner') saved.commandId = 'another-command'
  if (changed === 'batch') saved.batchId = 'another-batch'
  if (changed === 'revision') saved.revision = 3
  if (changed === 'version') saved.toVersion = 3
  if (changed === 'committed') saved.committedAt = input.now
  expect(uploadError(saved, prepared, command, changed === 'checksum' ? 'different' : prepared.blobSha256, changed === 'pointer' ? 3 : 1, changed === 'other-commit')).toBe(changed === 'owner' ? 'superseded' : changed === 'pointer' ? 'stale_baseline' : 'version_taken')
})

test('D: only matching prepared identity, version and bytes pass the before-upload proof', () => {
  expect(uploadError(prepared, prepared, command, prepared.blobSha256, 1, false)).toBeNull()
})

test('confirming a submitted draft can start its own command alongside the waiting review', () => {
  const waiting = {
    ...input,
    batch: { ...batch, approvalRun: { runId: 'waiting-for-review', revision: batch.revision - 1 } },
    claim: undefined,
    runStatus: 'running',
  }
  expect(retryEligibility(waiting)).toMatchObject({ canRetry: false, reason: 'not_waiting' })
  const confirmed = { ...fresh, confirmedDraftRevision: batch.revision - 1 }
  expect(retryEligibility({ ...waiting, command: confirmed })).toMatchObject({ canRetry: true })
  expect(retryEligibility({ ...waiting, command: confirmed, claim: { ...input.claim!, runId: 'active-publish' } }))
    .toMatchObject({ canRetry: false, reason: 'locked' })
})
