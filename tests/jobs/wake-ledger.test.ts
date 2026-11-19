import { expect, test } from 'vitest'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { wakeKey } from '../../lib/jobs/wake-ledger'
import { wakeLedgerScenario } from './wake-ledger-scenario'

test('the memory store hands each job transition to one waker', async () => {
  await wakeLedgerScenario(
    createMemoryJobsStore(createMemoryStore([]), 'development')
  )
})

test('a wake key names the run, attempt, step, job and transition', () => {
  const queued = {
    id: 'job',
    queueRunId: 'run',
    queueAttempt: 2,
    queueStep: 3,
    state: 'queued',
    createdAt: 10,
  }
  const claimed = { ...queued, state: 'claimed', claimId: 'c1', startedAt: 20 }
  const reclaimed = { ...claimed, claimId: 'c2', startedAt: 40 }
  const completed = { ...claimed, state: 'completed', completedAt: 30 }
  const keys = [queued, claimed, reclaimed, completed].map(wakeKey)
  expect(new Set(keys).size).toBe(4)
  expect(wakeKey(completed)).toBe('run:2:3:job:completed:c1:30')
})
