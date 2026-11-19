import { createHash } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import { acceptImage } from '../../lib/review/image'
import { createMemoryStore } from '../../lib/review/memory-store'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { plateRevision } from '../../lib/review/draft/revision'
import type { JobsDeps, TaggingJob } from '../../lib/jobs/types'
import type { ReviewDeps } from '../../lib/review/types'

afterEach(() => vi.unstubAllEnvs())

/**
 * Prepare a completed image job and verified fixture bytes for image acceptance tests.
 */
async function setup() {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const actor = { uid: 'editor', name: null, role: 'editor' as const }
  const plate = {
    id: 'AK.a',
    state: 'AK',
    slug: 'a',
    displayName: 'A',
    image: 'a.webp',
    tags: [],
    templateRole: 'template' as const,
    templateFamily: 'AK.a',
    isStandard: true,
  }
  const store = createMemoryStore([
    {
      id: 'batch',
      name: 'Image',
      createdBy: actor.uid,
      createdAt: '',
      revision: 0,
      baselineVersion: 1,
      state: 'open',
      approval: null,
      plateIds: [plate.id],
      stateOrders: { AK: [plate.id] },
    },
  ])
  const d: ReviewDeps = {
    store,
    /** Supply the test plate as the catalog baseline. */ baseline: async () =>
      plate,
    /** Supply the test plate as the catalog baseline. */ baselineAtVersion:
      async () => plate,
    /** Return the fixture state order used by the review or queue operation. */ stateBaseline:
      async () => [plate],
    /** Use an empty timestamp where the scenario does not depend on dates. */ now: () =>
      '',
  }
  const jobs: JobsDeps = {
    store: createMemoryJobsStore(store, 'development'),
    baseline: d.baseline,
    localScope: 'scope',
    /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () =>
      0,
    /** Supply a deterministic ID so the test can identify the generated record. */ id: () =>
      'claim',
    leaseMs: 1000,
  }
  const bytes = Buffer.from('verified fixture content')
  const candidate = {
    id: 'candidate',
    title: 'Photo',
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Plate.jpg',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Plate.jpg',
    width: 640,
    height: 320,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
  const job: TaggingJob = {
    id: 'image',
    batchId: 'batch',
    plateId: plate.id,
    requestedBy: actor.uid,
    inputHash: plateRevision(plate),
    env: 'development',
    localScope: 'scope',
    stage: 'find-image',
    state: 'completed',
    createdAt: 0,
    result: {
      suggestions: [],
      fieldSuggestion: {
        kind: 'image',
        stage: 'find-image',
        candidates: [candidate],
        sources: [candidate.imageUrl, candidate.sourceUrl],
      },
      model: 'search',
      backend: 'search',
      promptVersion: 'fixture',
      durationMs: 0,
    },
  }
  await jobs.store.transaction(async (tx) => {
    tx.create(job)
  })
  const input = {
    batchId: 'batch',
    jobId: 'image',
    candidateId: 'candidate',
    baseRevision: job.inputHash,
  }
  const read = vi.fn(async () => bytes)
  return { actor, plate, d, jobs, bytes, candidate, job, input, read }
}

test('accepts only a stored same-Batch candidate and preserves its paired provenance', async () => {
  const s = await setup()
  expect(await s.d.store.listEdits('batch')).toEqual([])
  expect(
    await acceptImage(s.d, s.jobs, s.actor, s.input, s.read)
  ).toMatchObject({ ok: true })
  expect((await s.d.store.getEdit('batch', s.plate.id))?.fields).toEqual({
    imageUrl: s.candidate.imageUrl,
    sourceUrl: s.candidate.sourceUrl,
  })
  expect(s.plate.image).toBe('a.webp')
})

test('rejects wrong candidate, Batch, local scope, checksum and stale revision without writes', async () => {
  const s = await setup()
  for (const input of [
    { ...s.input, candidateId: 'other' },
    { ...s.input, batchId: 'other' },
    { ...s.input, baseRevision: 'stale' },
  ]) {
    expect(
      await acceptImage(s.d, s.jobs, s.actor, input, s.read)
    ).toMatchObject({ ok: false })
  }
  expect(
    await acceptImage(
      s.d,
      { ...s.jobs, localScope: 'other' },
      s.actor,
      s.input,
      s.read
    )
  ).toMatchObject({ ok: false })
  expect(
    await acceptImage(s.d, s.jobs, s.actor, s.input, async () =>
      Buffer.from('changed')
    )
  ).toMatchObject({ ok: false })
  expect(await s.d.store.listEdits('batch')).toEqual([])
  expect(s.read).not.toHaveBeenCalled()
})

test('connected-run jobs cannot bypass aggregate Apply', async () => {
  const s = await setup()
  await s.jobs.store.transaction(async (tx) => {
    tx.set({ ...s.job, ...{ queueRunId: 'run' } })
  })
  expect(
    await acceptImage(s.d, s.jobs, s.actor, s.input, s.read)
  ).toMatchObject({ error: 'invalid_state' })
  expect(s.read).not.toHaveBeenCalled()
})
