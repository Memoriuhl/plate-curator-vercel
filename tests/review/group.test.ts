import { afterEach, expect, test, vi } from 'vitest'
import { createMemoryStore } from '../../lib/review/memory-store'
import { acceptGroup, completeGroupScope } from '../../lib/review/group'
import { plateRevision } from '../../lib/review/draft/revision'
import type { Plate } from '../../lib/catalog/types'
import type { ReviewDeps } from '../../lib/review/types'
import type { GroupSuggestion } from '../../lib/jobs/specialized-suggestions'
import { proposeEdit, reorderState } from '../../lib/review/batches/batch'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import type { JobsDeps, TaggingJob } from '../../lib/jobs/types'

afterEach(() => vi.unstubAllEnvs())
const actor = { uid: 'editor', name: null, role: 'editor' as const }
/**
 * Prepare a scoped group suggestion and an editable batch so acceptance can validate
 * their revisions.
 */
function setup() {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const plates: Plate[] = ['a', 'b', 'c'].map((id, i) => ({
    id: `AK.${id}`,
    state: 'AK',
    slug: id,
    displayName: id,
    tags: [],
    image: `${id}.webp`,
    templateFamily: `old-${id}`,
    templateRole: 'template',
    isStandard: i === 0,
  }))
  const store = createMemoryStore([
    {
      id: 'batch',
      name: 'Group',
      createdBy: actor.uid,
      createdAt: '',
      revision: 0,
      baselineVersion: 1,
      state: 'open',
      approval: null,
      plateIds: ['AK.a', 'AK.b'],
      stateOrders: { AK: plates.map((plate) => plate.id) },
    },
  ])
  const d: ReviewDeps = {
    store,
    /** Resolve the plate by ID from the fixture baseline. */ baseline: async (
      id
    ) => plates.find((plate) => plate.id === id) ?? null,
    /** Resolve the plate by ID from the fixture baseline. */ baselineAtVersion:
      async (_, id) => plates.find((plate) => plate.id === id) ?? null,
    /** Return the fixture state order used by the review or queue operation. */ stateBaseline:
      async () => plates,
    /** Use an empty timestamp where the scenario does not depend on dates. */ now: () =>
      '',
  }
  const suggestion: GroupSuggestion = {
    kind: 'group',
    stage: 'group',
    sources: [],
    scope: plates.slice(0, 2).map((plate) => ({
      plateId: plate.id,
      baseRevision: plateRevision(plate),
    })),
    proposals: plates.slice(0, 2).map((plate, i) => ({
      plateId: plate.id,
      baseRevision: plateRevision(plate),
      fields: {
        templateFamily: 'AK.a',
        templateRole: i === 0 ? 'template' : 'variant',
        variantOfPlateId: i === 0 ? null : 'AK.a',
      },
    })),
  }
  const jobs: JobsDeps = {
    store: createMemoryJobsStore(store, 'development'),
    baseline: d.baseline,
    baselineAtVersion: d.baselineAtVersion,
    stateBaseline: d.stateBaseline,
    localScope: 'scope',
    /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () =>
      0,
    /** Supply a deterministic ID so the test can identify the generated record. */ id: () =>
      'claim',
    leaseMs: 1000,
  }
  /**
   * Seed a completed grouping job with the proposal the curator acceptance path should
   * inspect.
   */
  const seed = (result = suggestion) =>
    jobs.store.transaction(async (tx) => {
      const job: TaggingJob = {
        id: 'group',
        batchId: 'batch',
        plateId: plates[0].id,
        requestedBy: actor.uid,
        inputHash: plateRevision(plates[0]),
        env: 'development',
        localScope: 'scope',
        stage: 'group',
        groupScope: plates.slice(0, 2).map((plate) => ({
          plate: structuredClone(plate),
          baseRevision: plateRevision(plate),
        })),
        standardId: plates[0].id,
        state: 'completed',
        createdAt: 0,
        result: {
          fieldSuggestion: result,
          suggestions: [],
          model: 'fixture',
          backend: 'fixture',
          promptVersion: 'fixture',
          durationMs: 0,
        },
      }
      tx.set(job)
    })
  return { d, store, plates, suggestion, jobs, seed }
}

test('applies all group members in one Batch revision and preserves unrelated data, order and Standard', async () => {
  const s = setup()
  await s.seed()
  expect(await s.store.listEdits('batch')).toEqual([])
  expect(
    await acceptGroup(s.d, s.jobs, actor, {
      batchId: 'batch',
      batchRevision: 0,
      jobId: 'group',
    })
  ).toMatchObject({
    ok: true,
    value: { revision: 1, stateOrders: { AK: ['AK.a', 'AK.b', 'AK.c'] } },
  })
  const edits = await s.store.listEdits('batch')
  expect(edits).toHaveLength(2)
  expect(edits.find((edit) => edit.plateId === 'AK.b')?.fields).toMatchObject({
    templateFamily: 'AK.a',
    templateRole: 'variant',
    variantOfPlateId: 'AK.a',
  })
  expect(s.plates[1].templateFamily).toBe('old-b')
  expect(edits.every((edit) => edit.fields.isStandard === undefined)).toBe(true)
  expect(
    await acceptGroup(s.d, s.jobs, actor, {
      batchId: 'batch',
      batchRevision: 0,
      jobId: 'group',
    })
  ).toMatchObject({ error: 'superseded_revision' })
})

test('rejects stale peers, partial families and invalid Standard proposals without partial writes', async () => {
  const s = setup()
  await s.seed()
  s.plates[1].description = 'Changed peer'
  expect(
    await acceptGroup(s.d, s.jobs, actor, {
      batchId: 'batch',
      batchRevision: 0,
      jobId: 'group',
    })
  ).toMatchObject({ error: 'stale_plate' })
  expect(await s.store.listEdits('batch')).toEqual([])
  delete s.plates[1].description
  s.plates[2].templateFamily = s.plates[1].templateFamily
  expect(completeGroupScope(s.plates.slice(0, 2), s.plates)).toBe(false)
  expect(
    await acceptGroup(s.d, s.jobs, actor, {
      batchId: 'batch',
      batchRevision: 0,
      jobId: 'group',
    })
  ).toMatchObject({ error: 'invalid_state' })
  s.plates[2].templateFamily = 'old-c'
  const swapped: GroupSuggestion = {
    ...s.suggestion,
    proposals: s.suggestion.proposals.map((value, i) => ({
      ...value,
      fields: {
        templateFamily: 'AK.b',
        templateRole: i === 1 ? 'template' : 'variant',
        variantOfPlateId: i === 1 ? null : 'AK.b',
      },
    })),
  }
  await s.seed(swapped)
  expect(
    await acceptGroup(s.d, s.jobs, actor, {
      batchId: 'batch',
      batchRevision: 0,
      jobId: 'group',
    })
  ).toMatchObject({ error: 'invalid_state' })
  expect(await s.store.listEdits('batch')).toEqual([])
})

test('authorization, flag and CAS failure cannot create partial edits', async () => {
  const s = setup()
  await s.seed()
  expect(
    await acceptGroup(
      s.d,
      s.jobs,
      { ...actor, uid: 'other' },
      { batchId: 'batch', batchRevision: 0, jobId: 'group' }
    )
  ).toMatchObject({ error: 'not_found' })
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  expect(
    await acceptGroup(s.d, s.jobs, actor, {
      batchId: 'batch',
      batchRevision: 0,
      jobId: 'group',
    })
  ).toMatchObject({ error: 'forbidden' })
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  s.store.commit = async () => 'revision_mismatch'
  expect(
    await acceptGroup(s.d, s.jobs, actor, {
      batchId: 'batch',
      batchRevision: 0,
      jobId: 'group',
    })
  ).toMatchObject({ error: 'superseded_revision' })
  expect(await s.store.listEdits('batch')).toEqual([])
})

test('image overrides retain paired provenance through Standard rebuilds with the local gate off', async () => {
  const s = setup()
  await s.seed()
  const imageUrl =
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Plate.jpg'
  const sourceUrl = 'https://commons.wikimedia.org/wiki/File:Plate.jpg'
  const saved = await proposeEdit(s.d, actor, {
    batchId: 'batch',
    plateId: s.plates[0].id,
    baseRevision: plateRevision(s.plates[0]),
    fields: { imageUrl, sourceUrl },
  })
  expect(saved).toMatchObject({ ok: true })
  if (!saved.ok) throw Error('Expected draft edit')
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  const reordered = await reorderState(s.d, actor, {
    batchId: 'batch',
    state: 'AK',
    batchRevision: saved.value.batch.revision,
    order: ['AK.b', 'AK.a', 'AK.c'],
    standard: { from: 'AK.a', to: 'AK.b' },
  })
  expect(reordered).toMatchObject({ ok: true })
  expect((await s.store.getEdit('batch', 'AK.a'))?.fields).toMatchObject({
    imageUrl,
    sourceUrl,
  })
})
