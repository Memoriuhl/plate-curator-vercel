import { revertPipelineRun, type RunRevertResult } from '../review/revert-run'
import type { Actor, Outcome, ReviewDeps } from '../review/types'
import type { JobsDeps } from './types'
import { localQueueEnabled } from './queue'
import type { PipelineRun } from './queue-types'

const settled = (run: PipelineRun) =>
  run.status === 'completed' ||
  run.status === 'failed' ||
  run.status === 'cancelled'

/** Revert a shared-draft run in this queue scope, serialized against retries. */
export async function revertQueueRun(
  jobs: JobsDeps,
  review: ReviewDeps,
  actor: Actor,
  batchId: string,
  runId: string
): Promise<Outcome<RunRevertResult>> {
  if (!localQueueEnabled(jobs)) return { ok: false, error: 'forbidden' }
  const run = await jobs.store.transaction((tx) => tx.getRun(runId))
  if (!run || run.localScope !== jobs.localScope || run.batchId !== batchId)
    return { ok: false, error: 'not_found' }
  if (!settled(run))
    return {
      ok: false,
      error: 'pipeline_busy',
      reasons: [
        'Wait for this pipeline run to finish or cancel it before reverting its changes.',
      ],
    }
  return revertPipelineRun(
    {
      ...review,
      store: {
        ...review.store,
        commit: (...args) =>
          jobs.store.transaction(async (tx) => {
            const current = await tx.getRun(runId)
            if (
              !current ||
              !settled(current) ||
              current.attempts.length !== run.attempts.length
            )
              return 'pipeline_busy'
            return tx.commitDraft(...args)
          }),
      },
    },
    actor,
    { batchId, runId }
  )
}
