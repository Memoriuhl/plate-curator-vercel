import {
  revertPipelineRun,
  type RunRevertResult,
} from '../review/draft/revert-run'
import type { Actor, Outcome, ReviewDeps } from '../review/types'
import type { JobsDeps } from './types'
import { localQueueEnabled } from './queue/queue'
import type { PipelineRun } from './queue/queue-types'
import { runRevertTarget, type RunRevertTarget } from './revert-target'

function settled(run: PipelineRun) {
  return (
    run.status === 'completed' ||
    run.status === 'failed' ||
    run.status === 'cancelled'
  )
}

function matches(run: PipelineRun, confirmed: RunRevertTarget) {
  const attempt = run.attempts.at(-1)
  return (
    attempt?.number === confirmed.attempt &&
    attempt.jobIds.length === confirmed.jobIds.length &&
    attempt.jobIds.every((id, i) => id === confirmed.jobIds[i])
  )
}

async function readRun(
  jobs: JobsDeps,
  batchId: string,
  runId: string
): Promise<Outcome<PipelineRun>> {
  if (!localQueueEnabled(jobs)) return { ok: false, error: 'forbidden' }
  const run = await jobs.store.transaction((tx) => tx.getRun(runId))
  if (!run || run.localScope !== jobs.localScope || run.batchId !== batchId)
    return { ok: false, error: 'not_found' }
  return { ok: true, value: run }
}

export async function readRunRevertTarget(
  jobs: JobsDeps,
  batchId: string,
  runId: string
): Promise<Outcome<RunRevertTarget | null>> {
  const run = await readRun(jobs, batchId, runId)
  if (!run.ok) return run
  return {
    ok: true,
    value: settled(run.value)
      ? runRevertTarget(run.value.attempts.at(-1)!)
      : null,
  }
}

const changedAttempt: Outcome<never> = {
  ok: false,
  error: 'superseded_revision',
  reasons: [
    'This pipeline attempt changed. Review the latest results before reverting.',
  ],
}

/** Revert a shared-draft run in this queue scope, serialized against retries. */
export async function revertQueueRun(
  jobs: JobsDeps,
  review: ReviewDeps,
  actor: Actor,
  batchId: string,
  runId: string,
  confirmed: RunRevertTarget
): Promise<Outcome<RunRevertResult>> {
  const run = await readRun(jobs, batchId, runId)
  if (!run.ok) return run
  if (!matches(run.value, confirmed)) return changedAttempt
  if (!settled(run.value))
    return {
      ok: false,
      error: 'pipeline_busy',
      reasons: [
        'Wait for this pipeline run to finish or cancel it before reverting its changes.',
      ],
    }
  const outcome = await revertPipelineRun(
    {
      ...review,
      store: {
        ...review.store,
        commit: (...args) =>
          jobs.store.transaction(async (tx) => {
            const current = await tx.getRun(runId)
            if (!current || !matches(current, confirmed) || !settled(current))
              return 'superseded_revision'
            return tx.commitDraft(...args)
          }),
      },
    },
    actor,
    { batchId, runId }
  )
  if (!outcome.ok && outcome.error === 'superseded_revision')
    return changedAttempt
  if (outcome.ok && !outcome.value.reverted) {
    const current = await readRun(jobs, batchId, runId)
    if (!current.ok || !matches(current.value, confirmed)) return changedAttempt
  }
  return outcome
}
