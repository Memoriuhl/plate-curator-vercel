import { afterAll, expect, test, vi } from 'vitest'
import { jobsScenarios } from '../tests/jobs/scenarios'
import { firestoreJobsStore } from '../lib/jobs/firestore-store'
import { claimNext } from '../lib/jobs/jobs'
import { localJobsEnvironment } from '../lib/jobs/local-scope'
import type { JobsDeps, TaggingJob } from '../lib/jobs/types'
import { firestoreReviewStore } from '../lib/review/firestore-store'
import { Firestore, QuerySnapshot, Transaction } from '@google-cloud/firestore'
import { wakeLedgerScenario } from '../tests/jobs/wake-ledger-scenario'
import './setup'

const db = new Firestore({ projectId: 'demo-plate-curator-jobs' })

jobsScenarios(async () => {
  await db.recursiveDelete(db.collection('jobs'))
  await db.recursiveDelete(db.collection('workerTokens'))
  await db.recursiveDelete(db.collection('reviewBatches'))
  return {
    store: firestoreJobsStore(db, 'development'),
    other: firestoreJobsStore(db, 'production'),
    review: firestoreReviewStore(db, 'development'),
  }
})

const claimEnv = 'preview:hosted-claim-proof'
const claimDeps: JobsDeps = {
  store: firestoreJobsStore(db, claimEnv),
  baseline: async () => null,
  now: () => 1000,
  id: () => 'claim-proof',
  leaseMs: 100,
}

function job(id: string, overrides: Partial<TaggingJob> = {}): TaggingJob {
  return {
    id,
    batchId: 'batch',
    plateId: 'one',
    requestedBy: 'editor',
    inputHash: 'input',
    env: claimEnv,
    createdAt: 0,
    state: 'queued',
    ...overrides,
  }
}

async function seedJobs(records: TaggingJob[]) {
  const writer = db.bulkWriter()
  const writes = records.map((record) =>
    writer.create(db.collection('jobs').doc(record.id), record)
  )
  await Promise.all([...writes, writer.close()])
}

test.each(['standalone', 'scoped'] as const)(
  '%s idle claims read zero historical job or run documents',
  async (mode) => {
    const scope = mode === 'scoped' ? 'hosted-claim-proof' : undefined
    const env = scope ? localJobsEnvironment(scope) : claimEnv
    const deps = {
      ...claimDeps,
      store: firestoreJobsStore(db, env),
      localScope: scope,
    }
    if (scope) vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
    const get = vi.spyOn(Transaction.prototype, 'get')
    async function documentsRead() {
      get.mockClear()
      expect(await claimNext(deps, 'worker')).toBeNull()
      const snapshots = await Promise.all(
        get.mock.results.map((call) => call.value)
      )
      return snapshots.reduce(
        (count, snapshot) =>
          count + (snapshot instanceof QuerySnapshot ? snapshot.size : 0),
        0
      )
    }
    try {
      expect(await documentsRead()).toBe(0)
      await seedJobs(
        Array.from({ length: 1000 }, (_, i) =>
          job(`${mode}-finished-${i}`, {
            env,
            ...(scope ? { localScope: scope } : {}),
            state: 'completed',
            createdAt: i,
          })
        )
      )
      if (scope) {
        await db.collection('localPipelineRuns').doc(scope).create({
          id: scope,
          env,
          localScope: scope,
          status: 'completed',
          lastDispatchedAt: 10,
          requestedBy: 'editor',
        })
      }
      expect(await documentsRead()).toBe(0)
    } finally {
      get.mockRestore()
      vi.unstubAllEnvs()
    }
  },
  20_000
)

test('standalone claims reach legacy desktop jobs beyond hosted pages and order by creation time', async () => {
  await seedJobs([
    ...Array.from({ length: 20 }, (_, i) =>
      job(`hosted-queued-${i}`, { route: 'hosted', createdAt: i })
    ),
    ...Array.from({ length: 20 }, (_, i) =>
      job(`hosted-expired-${i}`, {
        route: 'hosted',
        createdAt: i,
        state: 'claimed',
        leaseExpiresAt: 900,
      })
    ),
    job('a', { createdAt: 50, state: 'claimed', leaseExpiresAt: 1000 }),
    job('A', { createdAt: 50 }),
    job('third', { createdAt: 60, state: 'claimed', leaseExpiresAt: 900 }),
    job('unexpired', { state: 'claimed', leaseExpiresAt: 1001 }),
    job('different-environment', { env: 'preview:other' }),
    job('local', { localScope: 'another-worker' }),
    job('queue-run', { queueRunId: 'run' }),
  ])
  for (const id of ['a', 'A', 'third']) {
    expect(await claimNext(claimDeps, 'worker')).toMatchObject({
      job: { id, state: 'claimed', leaseExpiresAt: 1100 },
    })
  }
  expect(await claimNext(claimDeps, 'worker')).toBeNull()
}, 20_000)

afterAll(async () => {
  await db.recursiveDelete(db.collection('jobs'))
  await db.recursiveDelete(db.collection('localPipelineRuns'))
  await db.recursiveDelete(db.collection('workerTokens'))
  await db.recursiveDelete(db.collection('reviewBatches'))
  await db.terminate()
})

test('the Firestore wake ledger hands each job transition to one waker', async () => {
  await db.recursiveDelete(db.collection('localPipelineWakes'))
  await wakeLedgerScenario(firestoreJobsStore(db, 'preview:wake-ledger'))
  // Environments keep separate ledgers.
  expect(
    await firestoreJobsStore(db, 'preview:other-ledger').claimWake!(
      'run',
      'report',
      100,
      15_000
    )
  ).toBe(true)
})
