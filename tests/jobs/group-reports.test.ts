import { afterEach, expect, test, vi } from 'vitest'
import { createJob, claimNext, reportResult } from '../../lib/jobs/jobs'
import { createMemoryJobsStore } from '../../lib/jobs/memory-store'
import { createMemoryStore } from '../../lib/review/memory-store'
import { plateRevision } from '../../lib/review/revision'
import { groupProposal } from '../../worker/image-group'
import type { JobsDeps } from '../../lib/jobs/types'

afterEach(() => vi.unstubAllEnvs())

test('Group reports bind every persisted job member and remain idempotent after Batch acceptance', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  const plates = ['a', 'b'].map((id) => ({
    id: `AK.${id}`,
    slug: id,
    state: 'AK',
    displayName: id,
    tags: [],
    image: `${id}.webp`,
  }))
  const review = createMemoryStore([
    {
      id: 'batch',
      name: 'Group',
      createdBy: 'editor',
      createdAt: '',
      state: 'open',
      revision: 0,
      baselineVersion: 1,
      approval: null,
      plateIds: plates.map((plate) => plate.id),
    },
  ])
  const deps: JobsDeps = {
    store: createMemoryJobsStore(review, 'development'),
    /** Resolve the plate by ID from the fixture baseline. */ baseline: async (
      id
    ) => plates.find((plate) => plate.id === id) ?? null,
    /** Return the fixture state order used by the review or queue operation. */ stateBaseline:
      async () => plates,
    /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () =>
      100,
    /** Supply a deterministic ID so the test can identify the generated record. */ id: () =>
      'claim',
    leaseMs: 10000,
    localScope: 'test',
  }
  const groupScope = plates.map((plate) => ({
    plate: structuredClone(plate),
    baseRevision: plateRevision(plate),
  }))
  expect(
    await createJob(deps, {
      id: 'group',
      batchId: 'batch',
      plateId: plates[0].id,
      requestedBy: 'editor',
      stage: 'group',
      groupScope,
    })
  ).toMatchObject({ ok: true })
  const claim = await claimNext(deps, 'worker')
  if (!claim) throw Error('Missing claim')
  const fieldSuggestion = groupProposal(groupScope, {
    model: 'dinov2_vits14',
    groups: [{ templateId: plates[0].id, variants: [{ id: plates[1].id }] }],
    similarities: [
      [1, 0.9],
      [0.9, 1],
    ],
  })!
  const result = {
    backend: 'local-cpu',
    model: 'dinov2_vits14',
    promptVersion: 'test',
    durationMs: 10,
    fieldSuggestion,
  }
  /** Send the supplied grouping report under the fixture worker's active job claim. */
  const send = (payload = result) =>
    reportResult(deps, 'worker', 'group', claim.claimId, payload)
  expect(
    await send({
      ...result,
      fieldSuggestion: {
        ...fieldSuggestion,
        scope: fieldSuggestion.scope.slice(1),
      },
    })
  ).toMatchObject({ error: 'invalid_result' })
  plates[1].displayName = 'Changed peer'
  expect(await send()).toMatchObject({ error: 'stale_input' })
  expect(await review.listEdits('batch')).toEqual([])
  plates[1].displayName = 'b'
  expect(await send()).toMatchObject({
    ok: true,
    value: { state: 'completed' },
  })
  plates[1].displayName = 'Accepted elsewhere'
  expect(await send()).toMatchObject({
    ok: true,
    value: { state: 'completed' },
  })
  expect(await send({ ...result, durationMs: 11 })).toMatchObject({
    error: 'result_mismatch',
  })
})
