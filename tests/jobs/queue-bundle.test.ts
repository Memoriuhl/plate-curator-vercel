import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { localJobsEnvironment } from '../../lib/jobs/local-scope'
import { enqueueRun } from '../../lib/jobs/queue'
import { snapshotProjection } from '../../lib/jobs/queue-projection'
import { applyQueueBundle } from '../../lib/jobs/queue-bundle'
import { plateRevision } from '../../lib/review/revision'
import type { JobsDeps } from '../../lib/jobs/types'
import type { ReviewDeps } from '../../lib/review/types'

const actor = { uid: 'editor', role: 'editor' as const, name: null }

/**
 * Build a completed queue projection that tests can apply to a controlled batch
 * revision.
 */
async function setup(group = false) {
  const plates = ['one', 'two'].map((slug, index) => ({
    id: `AK.${slug}`,
    state: 'AK',
    slug,
    displayName: slug,
    image: '',
    tags: [],
    templateFamily: 'AK.one',
    templateRole: index ? ('variant' as const) : ('template' as const),
    variantOfPlateId: index ? 'AK.one' : null,
    isStandard: !index,
  }))
  const store = createMemoryStore([
    {
      id: 'batch',
      name: 'Queue',
      createdBy: actor.uid,
      createdAt: '',
      revision: 0,
      state: 'open',
      baselineVersion: 1,
      plateIds: plates.map((plate) => plate.id),
      approval: null,
      stateOrders: { AK: plates.map((plate) => plate.id) },
    },
  ])
  /** Resolve the plate by ID from the fixture baseline. */
  const baseline = async (id: string) =>
    plates.find((plate) => plate.id === id) ?? null
  const jobs: JobsDeps = {
    store: createMemoryJobsStore(store, localJobsEnvironment('test-bundle')),
    localScope: 'test-bundle',
    baseline,
    /** Return the fixture state order used by the review or queue operation. */ stateBaseline:
      async () => plates,
    /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () =>
      100,
    /** Supply a deterministic ID so the test can identify the generated record. */ id: () =>
      'id',
    leaseMs: 1000,
  }
  const review: ReviewDeps = {
    store,
    baseline,
    /** Resolve the plate by ID from the fixture baseline. */ baselineAtVersion:
      async (_version, id) => baseline(id),
    /** Return the fixture state order used by the review or queue operation. */ stateBaseline:
      async () => plates,
    /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () =>
      'today',
  }
  const created = await enqueueRun(jobs, actor, {
    requestId: 'bundle',
    batchId: 'batch',
    plateIds: plates.map((plate) => plate.id),
    stages: group ? ['describe', 'group'] : ['wiki-link', 'describe', 'story'],
  })
  if (!created.ok) throw Error(created.error)
  const projection = snapshotProjection(1, plates)
  for (const entry of Object.values(projection.plates)) {
    entry.executionPlate = {
      ...entry.executionPlate,
      wikiUrl: 'https://example.org/wiki',
      description: 'A sourced description',
      funFacts: [
        { text: 'A sourced fact', sourceUrl: 'https://example.org/wiki' },
      ],
    }
    entry.executionHash = plateRevision(entry.executionPlate)
    entry.sourceJobIds = ['wiki-job', 'description-job', 'story-job']
  }
  await jobs.store.transaction(async (tx) => {
    const [run] = await tx.runs()
    run.status = 'completed'
    const attempt = run.attempts[0]
    attempt.status = 'completed'
    attempt.cursor = attempt.steps.length
    attempt.projection = projection
    tx.setRun(run)
  })
  return { jobs, review, plates, id: created.value.id }
}

beforeEach(() => vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1'))
afterEach(() => vi.unstubAllEnvs())

test('Wiki + Describe + Story apply coherently in one revision; duplicate and concurrent Apply remain idempotent', async () => {
  const s = await setup()
  const commit = vi.spyOn(s.review.store, 'commit')
  const result = await applyQueueBundle(s.jobs, s.review, actor, s.id)
  expect(result).toMatchObject({ ok: true, value: { revision: 1 } })
  expect(commit).toHaveBeenCalledTimes(1)
  const edits = await s.review.store.listEdits('batch')
  expect(edits).toHaveLength(2)
  expect(edits[0].fields).toMatchObject({
    wikiUrl: 'https://example.org/wiki',
    description: 'A sourced description',
    funFacts: [{ text: 'A sourced fact' }],
  })
  expect(await applyQueueBundle(s.jobs, s.review, actor, s.id)).toEqual(result)
  expect(commit).toHaveBeenCalledTimes(1)
  expect(s.plates[0]).not.toHaveProperty('description')
  const another = await setup()
  expect(
    (
      await Promise.all([
        applyQueueBundle(another.jobs, another.review, actor, another.id),
        applyQueueBundle(another.jobs, another.review, actor, another.id),
      ])
    ).every((result) => result.ok)
  ).toBe(true)
  expect((await another.review.store.getBatch('batch'))?.revision).toBe(1)
})

test('external edit to ANY original member causes zero bundle writes, including group + fields', async () => {
  for (const group of [false, true]) {
    const s = await setup(group)
    const batch = (await s.review.store.getBatch('batch'))!
    await s.review.store.commit('batch', 0, {
      batch: { ...batch, revision: 1 },
      edit: {
        plateId: s.plates[1].id,
        baseRevision: plateRevision(s.plates[1]),
        fields: { description: 'External edit' },
        resultRevision: 'changed',
        authorId: 'other',
        updatedAt: '',
      },
    })
    const commit = vi.spyOn(s.review.store, 'commit')
    expect(await applyQueueBundle(s.jobs, s.review, actor, s.id)).toMatchObject(
      { error: 'stale_plate' }
    )
    expect(commit).not.toHaveBeenCalled()
    expect(await s.review.store.listEdits('batch')).toMatchObject([
      { fields: { description: 'External edit' } },
    ])
  }
})

test('invalid Group changes or a partial family reject the whole coherent fields bundle without writes', async () => {
  const s = await setup(true)
  await s.jobs.store.transaction(async (tx) => {
    const [run] = await tx.runs()
    run.attempts[0].projection!.plates[
      s.plates[0].id
    ].executionPlate.templateRole = 'variant'
    tx.setRun(run)
  })
  const commit = vi.spyOn(s.review.store, 'commit')
  expect(await applyQueueBundle(s.jobs, s.review, actor, s.id)).toMatchObject({
    error: 'invalid_state',
  })
  expect(commit).not.toHaveBeenCalled()
  expect(await s.review.store.listEdits('batch')).toEqual([])
})

test.each([
  ['cancelled', 'group_member_failed'],
  ['skipped', 'group_member_failed'],
  ['skipped', 'group_member_skipped'],
] as const)(
  'Apply preserves other plate results when Group is %s with %s',
  async (status, reason) => {
    const s = await setup(true)
    await s.jobs.store.transaction(async (tx) => {
      const [run] = await tx.runs()
      const attempt = run.attempts[0]
      const group = attempt.steps.find((step) => step.stage === 'group')!
      Object.assign(group, { status, reason })
      attempt.outcome = 'partial'
      const untouched = attempt.projection!.plates[s.plates[0].id]
      untouched.executionPlate = untouched.batchInput
      untouched.executionHash = untouched.batchInputHash
      untouched.sourceJobIds = []
      tx.setRun(run)
    })
    expect(await applyQueueBundle(s.jobs, s.review, actor, s.id)).toMatchObject(
      { ok: true, value: { revision: 1 } }
    )
    const edits = await s.review.store.listEdits('batch')
    expect(edits.map((edit) => edit.plateId)).toEqual([s.plates[1].id])
    expect(edits[0].fields).toMatchObject({
      description: 'A sourced description',
    })
  }
)

test('Apply permissions/read-only/local gates remain enforced, including after a prior successful application', async () => {
  const s = await setup()
  expect(
    await applyQueueBundle(s.jobs, s.review, { ...actor, uid: 'other' }, s.id)
  ).toMatchObject({ error: 'forbidden' })
  expect(await applyQueueBundle(s.jobs, s.review, actor, s.id)).toMatchObject({
    ok: true,
  })
  const batch = (await s.review.store.getBatch('batch'))!
  await s.review.store.commit('batch', batch.revision, {
    batch: { ...batch, revision: batch.revision + 1, state: 'submitted' },
  })
  expect(
    await applyQueueBundle(s.jobs, s.review, { ...actor, role: 'owner' }, s.id)
  ).toMatchObject({ error: 'invalid_state' })
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  expect(await applyQueueBundle(s.jobs, s.review, actor, s.id)).toMatchObject({
    error: 'forbidden',
  })
})

test('Preview is strictly inspect-only: server refuses Apply and cannot convert the persisted mode', async () => {
  const s = await setup()
  await s.jobs.store.transaction(async (tx) => {
    const [run] = await tx.runs()
    run.previewOnly = true
    tx.setRun(run)
  })
  const commit = vi.spyOn(s.review.store, 'commit')
  expect(await applyQueueBundle(s.jobs, s.review, actor, s.id)).toMatchObject({
    error: 'forbidden',
  })
  expect(
    await applyQueueBundle(s.jobs, s.review, { ...actor, role: 'owner' }, s.id)
  ).toMatchObject({ error: 'forbidden' })
  expect(commit).not.toHaveBeenCalled()
  expect(await s.review.store.listEdits('batch')).toEqual([])
})
