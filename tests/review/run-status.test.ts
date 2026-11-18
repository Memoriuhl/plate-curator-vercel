import { expect, test } from 'vitest'
import {
  approvalRunStatus,
  type ApprovalResult,
} from '../../lib/review/run-status'
import type { ReviewBatch } from '../../lib/review/types'

const batch: ReviewBatch = {
  id: 'batch',
  name: 'Review',
  createdBy: 'editor',
  createdByName: null,
  createdAt: '',
  state: 'submitted',
  revision: 1,
  baselineVersion: 7,
  plateIds: [],
  stateOrders: {},
  approval: null,
  approvalRun: { runId: 'run', revision: 1 },
}
test.each<{
  state: ReviewBatch['state']
  requested?: string
  result?: ApprovalResult
  status?: string
  phase: string
  outcome: unknown
}>([
  { state: 'submitted', phase: 'waiting-for-approval', outcome: null },
  { state: 'approved', phase: 'waiting-for-publish', outcome: null },
  { state: 'approved', requested: 'now', phase: 'publishing', outcome: null },
  { state: 'open', phase: 'superseded', outcome: null },
  {
    state: 'published',
    result: { outcome: 'published', version: 8 },
    phase: 'published',
    outcome: { version: 8 },
  },
  {
    state: 'approved',
    result: {
      outcome: 'publish_failed',
      error: 'invalid_snapshot',
      reasons: ['Broken grouping'],
    },
    phase: 'failed',
    outcome: { error: 'invalid_snapshot', reasons: ['Broken grouping'] },
  },
  {
    state: 'submitted',
    result: { outcome: 'superseded' },
    phase: 'superseded',
    outcome: null,
  },
  {
    state: 'submitted',
    result: { outcome: 'decision_timeout' },
    phase: 'timed-out',
    outcome: null,
  },
  {
    state: 'approved',
    result: { outcome: 'publish_timeout' },
    phase: 'timed-out',
    outcome: null,
  },
  {
    state: 'approved',
    status: 'failed',
    phase: 'failed',
    outcome: { error: 'Approval run failed', reasons: [] },
  },
])(
  'maps $state with $result to $phase',
  ({ state, requested, result, status, phase, outcome }) => {
    expect(
      approvalRunStatus(
        { ...batch, state, publishRequestedAt: requested },
        {
          status: status ?? (result ? 'completed' : 'running'),
          result,
          updatedAt: 'then',
        }
      )
    ).toEqual({
      runId: 'run',
      phase,
      outcome,
      updatedAt: requested && !result ? requested : 'then',
    })
  }
)

test.each(['failed', 'published', 'publish_failed'] as const)(
  'retains requester from Batch for %s without result identity',
  (phase) => {
    const requestedBy = {
      uid: 'requester',
      email: 'requester@example.com',
      authorityEpoch: 2,
    }
    const result: ApprovalResult | undefined =
      phase === 'published'
        ? { outcome: 'published', version: 8 }
        : phase === 'publish_failed'
          ? { outcome: 'publish_failed', error: 'revoked', reasons: [] }
          : undefined
    expect(
      approvalRunStatus(
        { ...batch, publishRequestedBy: requestedBy },
        {
          status: phase === 'failed' ? 'failed' : 'completed',
          result,
          updatedAt: null,
        }
      ).outcome?.requestedBy
    ).toEqual(requestedBy)
  }
)
test('prefers Workflow requester over Batch metadata', () => {
  const requestedBy = {
    uid: 'workflow',
    email: 'workflow@example.com',
    authorityEpoch: 3,
  }
  expect(
    approvalRunStatus(
      { ...batch, publishRequestedBy: { ...requestedBy, uid: 'batch' } },
      {
        status: 'completed',
        result: {
          outcome: 'publish_failed',
          error: 'revoked',
          reasons: [],
          requestedBy,
        },
        updatedAt: null,
      }
    ).outcome?.requestedBy
  ).toEqual(requestedBy)
})
