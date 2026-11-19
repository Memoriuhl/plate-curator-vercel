import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { plateRevision } from '../../../lib/review/revision'
import {
  projectJob,
  projectionMatchesBatch,
  snapshotProjection,
} from '../../../lib/jobs/queue/queue-projection'
import type { TaggingJob } from '../../../lib/jobs/types'

const plate = {
  id: 'AK.one',
  state: 'AK',
  slug: 'one',
  displayName: 'One',
  image: 'one.webp',
  tags: ['blue'],
  description: 'Original',
}
/** Build a completed description job for testing how results update a projection. */
function result(overrides: Partial<TaggingJob> = {}): TaggingJob {
  return {
    id: 'description',
    batchId: 'batch',
    plateId: plate.id,
    requestedBy: 'editor',
    inputHash: plateRevision(plate),
    executionHash: plateRevision(plate),
    env: 'preview:local-pipeline-test',
    localScope: 'test',
    createdAt: 100,
    state: 'completed',
    stage: 'describe',
    result: {
      suggestions: [],
      fieldSuggestion: {
        kind: 'fields',
        stage: 'describe',
        fields: { description: 'A sourced description' },
        sources: ['https://example.org/wiki'],
      },
      backend: 'test',
      model: 'fixture',
      promptVersion: 'v1',
      durationMs: 10,
    },
    ...overrides,
  }
}

beforeEach(() => vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1'))
afterEach(() => vi.unstubAllEnvs())

test('sequential stages consume persisted projected fields while Batch input/hash stay immutable', () => {
  const original = snapshotProjection(1, [plate])
  const projected = projectJob(original, result())
  if (!projected.ok) throw Error('Expected projection')
  const entry = projected.value.plates[plate.id]
  expect(entry.executionPlate.description).toBe('A sourced description')
  expect(entry.batchInput.description).toBe('Original')
  expect(entry.batchInputHash).toBe(plateRevision(plate))
  expect(entry.executionHash).not.toBe(entry.batchInputHash)
  expect(original.plates[plate.id].sourceJobIds).toEqual([])
  expect(plate.description).toBe('Original')
  const next = result({
    id: 'tag',
    stage: undefined,
    executionHash: entry.executionHash,
    result: {
      suggestions: ['graphic'],
      backend: 'test',
      model: 'fixture',
      promptVersion: 'v1',
      durationMs: 10,
    },
  })
  const tagged = projectJob(JSON.parse(JSON.stringify(projected.value)), next)
  expect(tagged).toMatchObject({
    ok: true,
    value: {
      plates: {
        [plate.id]: {
          batchInputHash: plateRevision(plate),
          executionPlate: {
            tags: ['blue', 'graphic'],
            description: 'A sourced description',
          },
          sourceJobIds: ['description', 'tag'],
        },
      },
    },
  })
})

test('replaying a projected job is idempotent and out-of-order/stale projected execution is rejected', () => {
  const original = snapshotProjection(1, [plate])
  const first = projectJob(original, result())
  if (!first.ok) throw Error('Expected projection')
  expect(projectJob(first.value, result())).toEqual(first)
  expect(projectJob(first.value, result({ id: 'out-of-order' }))).toEqual({
    ok: false,
    error: 'stale_input',
  })
  expect(projectJob(original, result({ inputHash: 'stale-batch' }))).toEqual({
    ok: false,
    error: 'stale_input',
  })
})

test('semantic no-result and failed transports stop dependencies instead of fabricating fields', () => {
  const projection = snapshotProjection(1, [plate])
  const job = result()
  expect(
    projectJob(projection, {
      ...job,
      result: {
        ...job.result!,
        fieldSuggestion: undefined,
        stageError: 'no_sources',
      },
    })
  ).toEqual({ ok: false, error: 'no_result', reason: 'no_sources' })
  expect(projectJob(projection, { ...job, state: 'expired' })).toMatchObject({
    error: 'stage_failed',
  })
  expect(
    projectJob(projection, {
      ...job,
      result: { ...job.result!, backend: 'missing-image' },
    })
  ).toMatchObject({ error: 'stage_failed' })
  expect(
    projectJob(projection, {
      ...job,
      result: { ...job.result!, fieldSuggestion: undefined },
    })
  ).toMatchObject({ error: 'invalid_result' })
})

test('retry snapshot checks actual Batch and baseline version, preserving user-accepted edits', () => {
  const projection = snapshotProjection(1, [plate])
  expect(projectionMatchesBatch(projection, 1, [plate])).toBe(true)
  expect(projectionMatchesBatch(projection, 2, [plate])).toBe(false)
  expect(
    projectionMatchesBatch(projection, 1, [
      { ...plate, description: 'User accepted a newer value' },
    ])
  ).toBe(false)
  expect(projectionMatchesBatch(projection, 1, [])).toBe(false)
  expect(projectionMatchesBatch(projection, 1, [plate, plate])).toBe(false)
})
