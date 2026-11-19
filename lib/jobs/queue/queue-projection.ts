import type { Plate } from '../../catalog/types'
import { plateRevision } from '../../review/revision'
import { parseFieldSuggestion } from '../suggestions'
import type { TaggingJob } from '../types'

export type ProjectedPlate = {
  batchInput: Plate
  batchInputHash: string
  executionPlate: Plate
  executionHash: string
  sourceJobIds: string[]
}
export type RunProjection = {
  baselineVersion: number
  plates: Record<string, ProjectedPlate>
}
export type ProjectionOutcome =
  | { ok: true; value: RunProjection }
  | {
      ok: false
      error: 'stale_input' | 'invalid_result' | 'no_result' | 'stage_failed'
      reason?: string
    }

/**
 * Capture the batch baseline, input revisions and execution inputs at the start of an
 * attempt.
 */
export function snapshotProjection(
  baselineVersion: number,
  plates: Plate[]
): RunProjection {
  return {
    baselineVersion,
    plates: Object.fromEntries(
      plates.map((plate) => {
        const hash = plateRevision(plate)
        return [
          plate.id,
          {
            batchInput: structuredClone(plate),
            batchInputHash: hash,
            executionPlate: structuredClone(plate),
            executionHash: hash,
            sourceJobIds: [],
          },
        ]
      })
    ),
  }
}

/**
 * Compare the projected source revisions with the batch before accepting work based on
 * them.
 */
export function projectionMatchesBatch(
  projection: RunProjection,
  baselineVersion: number,
  plates: Plate[]
) {
  return (
    projection.baselineVersion === baselineVersion &&
    plates.length === Object.keys(projection.plates).length &&
    new Set(plates.map((plate) => plate.id)).size === plates.length &&
    plates.every(
      (plate) =>
        projection.plates[plate.id]?.batchInputHash === plateRevision(plate)
    )
  )
}

/**
 * Validate a stage result against its execution input and fold the accepted fields into
 * the projection.
 */
export function projectJob(
  projection: RunProjection,
  job: TaggingJob
): ProjectionOutcome {
  const current = projection.plates[job.plateId]
  if (!current || current.batchInputHash !== job.inputHash)
    return { ok: false, error: 'stale_input' }
  if (current.sourceJobIds.includes(job.id))
    return { ok: true, value: projection }
  if (current.executionHash !== (job.executionHash ?? job.inputHash))
    return { ok: false, error: 'stale_input' }
  if (
    job.state !== 'completed' ||
    !job.result ||
    job.result.backend === 'missing-image'
  )
    return { ok: false, error: 'stage_failed' }
  if (job.result.stageError)
    return {
      ok: false,
      error: ['no_sources', 'no_supported_fields'].includes(
        job.result.stageError
      )
        ? 'no_result'
        : 'stage_failed',
      reason: job.result.stageError,
    }
  let next = current.executionPlate
  if (job.stage) {
    const suggestion = parseFieldSuggestion(
      job.result.fieldSuggestion,
      job.stage
    )
    if (suggestion?.kind === 'group') {
      if (
        suggestion.scope.length !== Object.keys(projection.plates).length ||
        suggestion.scope.some(
          (member) =>
            projection.plates[member.plateId]?.batchInputHash !==
            member.baseRevision
        ) ||
        job.groupScope?.some(
          (member) =>
            projection.plates[member.plate.id]?.executionHash !==
            plateRevision(member.plate)
        )
      )
        return { ok: false, error: 'stale_input' }
      const plates = { ...projection.plates }
      for (const proposal of suggestion.proposals) {
        const entry = plates[proposal.plateId]
        if (!entry || entry.batchInputHash !== proposal.baseRevision)
          return { ok: false, error: 'stale_input' }
        const executionPlate = { ...entry.executionPlate, ...proposal.fields }
        plates[proposal.plateId] = {
          ...entry,
          executionPlate,
          executionHash: plateRevision(executionPlate),
          sourceJobIds: [...entry.sourceJobIds, job.id],
        }
      }
      return { ok: true, value: { ...projection, plates } }
    }
    if (suggestion?.kind === 'enhanced-image')
      return { ok: true, value: projection }
    if (
      !suggestion ||
      !('fields' in suggestion) ||
      Object.hasOwn(suggestion.fields, 'sourceUrl')
    )
      return { ok: false, error: 'invalid_result' }
    next = { ...next, ...suggestion.fields }
  } else
    next = {
      ...next,
      tags: [
        ...new Set(
          [...next.tags, ...job.result.suggestions]
            .map((tag) => tag.trim().toLowerCase())
            .filter(Boolean)
        ),
      ],
    }
  return {
    ok: true,
    value: {
      ...projection,
      plates: {
        ...projection.plates,
        [job.plateId]: {
          ...current,
          executionPlate: next,
          executionHash: plateRevision(next),
          sourceJobIds: [...current.sourceJobIds, job.id],
        },
      },
    },
  }
}
