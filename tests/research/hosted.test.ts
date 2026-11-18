import { expect, test } from 'vitest'
import {
  dispatchEveResearch,
  finishEveResearch,
} from '../../lib/research/hosted'
import { createMemoryResearchStore } from '../../lib/research/memory-store'
import { createResearchMemoryState } from '../../lib/research/state'
import type { ResearchDeps } from '../../lib/research/jobs'
import type { ResearchJob } from '../../lib/research/types'
import type { ResearchStore } from '../../lib/research/store'
import { createMemoryStore } from '../../lib/review/memory-store'

/** Build scoped research and review dependencies around the supplied job store. */
function dependencies(store: ResearchStore): ResearchDeps {
  return {
    store,
    /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () =>
      1000,
    /** Keep the fixture requester active so hosted state transitions can proceed. */ active:
      async () => true,
    /** Supply a deterministic ID so the test can identify the generated record. */ id: () =>
      'id',
    hostedEnabled: true,
    review: {
      store: createMemoryStore([]),
      /** Simulate an absent plate in the catalog baseline for this case. */ baseline:
        async () => null,
      /** Simulate an absent plate in the catalog baseline for this case. */ baselineAtVersion:
        async () => null,
      /** Simulate a state with no available baseline plates. */ stateBaseline:
        async () => [],
      /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () =>
        'now',
    },
  }
}

test('restarted hosted dispatch reuses the stored operation identity and receipt', async () => {
  const job: ResearchJob = {
    id: 'job',
    requestKey: 'request',
    batchId: 'b',
    requestedBy: 'owner',
    env: 'development',
    input: {
      plateId: 'AZ.one',
      displayName: 'Wildlife',
      state: 'AZ',
      inputRevision: 'r1',
      baselineVersion: 14,
    },
    executor: 'eve',
    model: 'openai/gpt-6.1-sol',
    state: 'queued',
    createdAt: 0,
    deadline: 300000,
    counters: {},
  }
  const store = createMemoryResearchStore()
  await store.transaction(async (tx) => {
    tx.set(job)
  })
  const deps = dependencies(store)
  const operations: string[] = []
  /** Record the dispatched job and return a controlled hosted session and delivery ID. */
  const create = async (job: ResearchJob) => {
    operations.push(job.id)
    return { sessionId: 'session', deliveryId: 'delivery' }
  }
  expect(await dispatchEveResearch(deps, 'job', create)).toMatchObject({
    state: 'running',
    eve: { sessionId: 'session' },
  })
  expect(await dispatchEveResearch(deps, 'job', create)).toMatchObject({
    eve: { sessionId: 'session' },
  })
  expect(operations).toEqual(['job'])
  expect(
    await finishEveResearch(deps, 'job', createResearchMemoryState())
  ).toMatchObject({ state: 'running' })
})

test('a superseded hosted run cannot settle its draft as the active result', async () => {
  const store = createMemoryResearchStore()
  await store.transaction(async (tx) =>
    tx.set({
      id: 'job',
      env: 'development',
      state: 'superseded',
      executor: 'eve',
      requestedBy: 'owner',
    } as ResearchJob)
  )
  const state = createResearchMemoryState()
  await state.update('draft/job', () => ({
    value: { draft: { description: 'Late result' } },
    result: null,
  }))
  expect(
    await finishEveResearch(dependencies(store), 'job', state)
  ).toMatchObject({ state: 'superseded' })
})

test('a submitted draft waits for turn settlement so reported usage is retained', async () => {
  const store = createMemoryResearchStore()
  await store.transaction(async (tx) =>
    tx.set({
      id: 'job',
      env: 'development',
      state: 'running',
      executor: 'eve',
      requestedBy: 'owner',
      deadline: 300000,
    } as ResearchJob)
  )
  const state = createResearchMemoryState()
  await state.update('draft/job', () => ({
    value: { draft: { description: null }, sources: [] },
    result: null,
  }))
  expect(
    await finishEveResearch(dependencies(store), 'job', state)
  ).toMatchObject({ state: 'running' })
})
