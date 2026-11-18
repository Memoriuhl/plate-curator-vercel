import { expect, test } from 'vitest'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { listRunTimings, runTimingKey } from '../../lib/jobs/run-timings'
import { createMemoryStore } from '../../lib/review/memory-store'
import type { JobsDeps, TaggingJob } from '../../lib/jobs/types'
import type { Actor } from '../../lib/review/types'

const actor: Actor = { uid: 'editor', name: null, role: 'editor' }

function completed(id: string, durationMs: number, overrides: Partial<TaggingJob> = {}): TaggingJob {
  return { id, env: 'development', localScope: 'demo', requestedBy: 'editor', batchId: 'batch', plateId: 'AK.one', inputHash: 'hash',
    createdAt: 1, completedAt: 10, state: 'completed', workerId: 'Studio PC',
    result: { backend: 'ollama', model: 'gemma4:12b', durationMs, promptVersion: 'v1', suggestions: [] }, ...overrides }
}

function setup(): JobsDeps {
  return { store: createMemoryJobsStore(createMemoryStore([]), 'development'), localScope: 'demo', baseline: async () => null,
    now: () => 1000, id: () => 'id', leaseMs: 1000 }
}

test('timing averages use the reporting desktop, model, stage and hosted executor within the visible scope', async () => {
  const d = setup()
  const available = { available: true }
  await d.store.writeCapabilities('demo', { workerId: 'Studio PC', reportedAt: 990, capabilities: {
    group: available, embeddings: available, mask: available, vision: available, pollIntervalMs: 500,
  } })
  const fast = completed('fast', 1000)
  await d.store.transaction(async tx => {
    for (const job of [fast, completed('slow', 3000), completed('other-owner', 100_000, { requestedBy: 'other' }),
      completed('laptop', 100_000, { workerId: 'Laptop', completedAt: 100 }), completed('other-scope', 100_000, { localScope: 'elsewhere' }),
      completed('other-env', 100_000, { env: 'production' }), completed('failed', 100_000, { state: 'failed' }),
      completed('no-image', 10, { result: { ...fast.result!, backend: 'missing-image' } }),
      completed('no-result', 10, { result: { ...fast.result!, stageError: 'no_sources' } }),
      completed('different-model', 5000, { result: { ...fast.result!, model: 'gemma4:26b', durationMs: 5000 } }),
      completed('colors', 6000, { stage: 'colors' }), completed('gateway', 7000, { route: 'hosted', workerId: 'hosted' }),
      completed('eve', 8000, { stage: 'research', route: 'hosted', workerId: 'hosted', startedAt: 2 }),
      completed('legacy-eve', 60_000, { stage: 'research', route: 'hosted', workerId: 'hosted' }),
      completed('enhancement', 2500, { stage: 'enhance-image', result: { ...fast.result!, model: 'sharp', durationMs: 2500 } }),
    ]) tx.create(job)
  })
  expect(await listRunTimings(d, actor)).toEqual({
    [runTimingKey('tag', 'desktop', 'gemma4:12b')]: 2000,
    [runTimingKey('tag', 'desktop', 'gemma4:26b')]: 5000,
    [runTimingKey('colors', 'desktop', 'gemma4:12b')]: 6000,
    [runTimingKey('tag', 'gateway', 'gemma4:12b')]: 7000,
    [runTimingKey('research', 'eve', 'gemma4:12b')]: 8000,
    [runTimingKey('enhance-image', 'desktop', 'sharp')]: 2500,
  })
})

test('old samples roll out as more jobs finish for the same stage, device and model', async () => {
  const d = setup()
  await d.store.transaction(async tx => {
    tx.create(completed('oldest', 200_000, { completedAt: 2 }))
    for (let index = 0; index < 50; index++) tx.create(completed(`recent-${index}`, 6000, { completedAt: index + 3 }))
  })
  expect(await listRunTimings(d, actor)).toEqual({
    [runTimingKey('tag', 'desktop', 'gemma4:12b')]: 6000,
  })
})
