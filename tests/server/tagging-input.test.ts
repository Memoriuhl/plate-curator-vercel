import { expect, test, vi } from 'vitest'
import { createJob } from '../../lib/jobs/jobs'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { proposeEdit } from '../../lib/review/batch'
import { plateRevision } from '../../lib/review/revision'
import type { JobsDeps } from '../../lib/jobs/types'
import type { ReviewDeps } from '../../lib/review/types'

const mocks = vi.hoisted(() => ({ jobs: vi.fn(), review: vi.fn() }))
vi.mock('../../lib/server/context', () => ({
  currentWorker: async () => ({ ok: true, workerId: 'worker' }),
  jobsDeps: mocks.jobs,
  reviewDeps: mocks.review,
}))
const { POST } = await import('../../app/api/worker/claim/route')

test('worker receives the job snapshot even when the Batch draft changes before claim', async () => {
  const plate = { id: 'AK.one', state: 'AK', slug: 'one', displayName: 'One', image: '', tags: [] }
  const store = createMemoryStore([{ id: 'shared', name: 'Shared', createdBy: 'editor', createdByName: null, createdAt: 'now', state: 'open', revision: 0, baselineVersion: 1, stateOrders: {}, plateIds: [plate.id], approval: null }])
  const review: ReviewDeps = { store, baseline: async () => plate, baselineAtVersion: async () => plate, stateBaseline: async () => [plate], now: () => 'now' }
  const actor = { uid: 'editor', name: 'Editor', role: 'editor' } as const
  const first = await proposeEdit(review, actor, { batchId: 'shared', plateId: plate.id, baseRevision: plateRevision(plate), fields: { tags: ['reviewed'], templateFamily: 'navy' } })
  if (!first.ok) throw new Error('Edit failed')
  const jobs: JobsDeps = { store: createMemoryJobsStore(store, 'development'), baseline: review.baseline, now: () => 1000, id: () => 'claim', leaseMs: 1000 }
  await createJob(jobs, { id: 'job', batchId: 'shared', plateId: plate.id, requestedBy: actor.uid })
  await proposeEdit(review, actor, { batchId: 'shared', plateId: plate.id, baseRevision: plateRevision(first.value.plate), fields: { tags: ['later'] } })
  mocks.jobs.mockReturnValue(jobs)
  mocks.review.mockImplementation(() => { throw new Error('Job snapshot must supply the worker input') })
  const response = await POST(new Request('https://example.com/api/worker/claim', { method: 'POST' }))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ job: { batchId: 'shared', inputHash: plateRevision(first.value.plate) }, plate: { tags: ['reviewed'] } })
})

test('the claim names the desktop model the job asked for, and only desktop models', async () => {
  const plate = { id: 'AK.one', state: 'AK', slug: 'one', displayName: 'One', image: '', tags: [] }
  const store = createMemoryStore([{ id: 'shared', name: 'Shared', createdBy: 'editor', createdByName: null, createdAt: 'now', state: 'open', revision: 0, baselineVersion: 1, stateOrders: {}, plateIds: [plate.id], approval: null }])
  let sequence = 0
  const jobs: JobsDeps = { store: createMemoryJobsStore(store, 'development'), baseline: async () => plate, now: () => 1000 + sequence, id: () => `claim-${++sequence}`, leaseMs: 1000 }
  await createJob(jobs, { id: 'big', batchId: 'shared', plateId: plate.id, requestedBy: 'editor', modelId: 'desktop-gemma4-26b' })
  await createJob(jobs, { id: 'plain', batchId: 'shared', plateId: plate.id, requestedBy: 'editor' })
  mocks.jobs.mockReturnValue(jobs)
  const claim = () => POST(new Request('https://example.com/api/worker/claim', { method: 'POST' })).then(response => response.json())
  expect(await claim()).toMatchObject({ job: { id: 'big' }, model: 'gemma4:26b' })
  expect(await claim()).not.toHaveProperty('model')
})
