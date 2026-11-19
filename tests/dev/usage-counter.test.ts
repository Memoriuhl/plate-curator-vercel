import { afterEach, expect, test } from 'vitest'
import type { Firestore } from '@google-cloud/firestore'
import {
  collectionPattern,
  countRequest,
  instrumentFirestore,
  startUsageCounts,
  usageCounterFile,
  usageCounts,
} from '../../lib/dev/usage-counter'

const slot = Symbol.for('plate-curator.usage-counts')
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[slot]
})

test.each([
  [{ USAGE_COUNTER_FILE: '/tmp/usage.json' }, '/tmp/usage.json'],
  [{}, null],
  [{ USAGE_COUNTER_FILE: '/tmp/u.json', VERCEL_ENV: 'production' }, null],
  [{ USAGE_COUNTER_FILE: '/tmp/u.json', VERCEL_ENV: 'preview' }, null],
  [{ USAGE_COUNTER_FILE: '/tmp/u.json', NODE_ENV: 'production' }, null],
  [
    { USAGE_COUNTER_FILE: '/tmp/u.json', VERCEL_ENV: 'development' },
    '/tmp/u.json',
  ],
])('counts only in local development for %j', (env, file) => {
  expect(usageCounterFile(env)).toBe(file)
})

test('names collections without document ids', () => {
  const root = 'projects/p/databases/(default)/documents'
  expect(collectionPattern(`${root}/curatorJobs/env/jobs/abc`)).toBe(
    'curatorJobs/*/jobs'
  )
  expect(collectionPattern(`${root}/members/a`)).toBe('members')
  expect(collectionPattern(root)).toBe('(root)')
})

test('counts requests by method and path, skipping static assets', () => {
  countRequest('GET', '/api/jobs/runs')
  expect(usageCounts()).toBeNull()
  startUsageCounts(0)
  countRequest('GET', '/api/jobs/runs?x=1')
  countRequest('GET', '/api/jobs/runs')
  countRequest('GET', '/states/AK', true)
  countRequest('GET', '/_next/static/chunk.js')
  expect(usageCounts()?.routes).toEqual({
    'GET /api/jobs/runs': 2,
    'GET /states/AK (rsc)': 1,
  })
})

test('counts document reads, queries and committed writes once each', () => {
  const root = 'projects/p/databases/(default)/documents'
  const calls: string[] = []
  const db = {
    snapshot_: (value: unknown) => calls.push(`snapshot ${String(value)}`),
    request: (method: string) => calls.push(method),
    requestStream: (method: string) => calls.push(method),
  }
  instrumentFirestore(db as unknown as Firestore)
  expect(calls).toEqual([])
  db.snapshot_(`${root}/a/b`)
  expect(usageCounts()).toBeNull()

  startUsageCounts(0)
  instrumentFirestore(db as unknown as Firestore)
  instrumentFirestore(db as unknown as Firestore)
  const target = db as unknown as Record<string, (...args: unknown[]) => void>
  target.snapshot_(`${root}/curatorJobs/env/jobs/1`)
  target.snapshot_({ name: `${root}/members/a` })
  target.request('commit', {
    writes: [
      { update: { name: `${root}/curatorLive/env/batchRevisions/x` } },
      { delete: `${root}/curatorJobs/env/jobs/1` },
    ],
  })
  target.request('beginTransaction', {})
  target.requestStream('runQuery', false, {
    parent: `${root}/curatorJobs/env`,
    structuredQuery: { from: [{ collectionId: 'jobs' }] },
  })
  target.requestStream('runAggregationQuery', false, {
    parent: root,
    structuredAggregationQuery: {
      structuredQuery: { from: [{ collectionId: 'members' }] },
    },
  })
  expect(usageCounts()?.firestore).toEqual({
    documentReads: { 'curatorJobs/*/jobs': 1, members: 1 },
    queries: { 'curatorJobs/*/jobs': 1, 'count members': 1 },
    writes: { 'curatorLive/*/batchRevisions': 1, 'curatorJobs/*/jobs': 1 },
  })
  expect(calls).toHaveLength(7)
})
