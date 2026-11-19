import type { QueueRunSummary, QueueRunView, RunStatus } from './queue-types'
import type { LocalRunStage } from './queue-types'
import { isPlateFailure } from './pipeline-plan'

export type StepProgress = {
  index: number
  plateId: string
  plateName: string
  plateState?: string
  stage: LocalRunStage
  status: RunStatus | 'waiting' | 'skipped'
  phaseIndex?: number
  skippedPhases?: number[]
  durationMs?: number
  reason?: string
  servedByFallback?: string
  workerId?: string
}
export type PipelineProgress = {
  steps: StepProgress[]
  workerIds: string[]
  plateImages?: Record<string, string>
  startedAt?: number
  endedAt?: number
  workflowUrl?: string | null
  gatewayUrl?: string
}

/**
 * Turn the latest attempt and its jobs into queue progress, timings and per-stage status
 * for the dashboard.
 */
export function queueProgress(
  run: QueueRunView | QueueRunSummary
): PipelineProgress {
  const attempt = run.attempts.at(-1)!
  const projection = 'projection' in attempt ? attempt.projection : undefined
  const steps = (attempt.steps ?? []).map((step) => {
    const completedId =
      step.completedJobId ??
      (step.index < attempt.cursor &&
      step.status !== 'failed' &&
      step.status !== 'cancelled' &&
      step.status !== 'skipped'
        ? attempt.completedJobIds?.[step.index]
        : undefined)
    const job =
      run.jobs.find((job) => job.id === completedId) ??
      run.jobs.find(
        (job) =>
          job.queueAttempt === attempt.number && job.queueStep === step.index
      )
    const status =
      step.status === 'cancelled' || step.status === 'skipped'
        ? step.status
        : job?.result?.stageError ||
            job?.state === 'failed' ||
            job?.state === 'expired'
          ? 'failed'
          : step.status === 'failed'
            ? 'failed'
            : completedId || step.index < attempt.cursor
              ? 'completed'
              : job?.state === 'claimed'
                ? 'running'
                : job?.state === 'cancelled' || run.status === 'cancelled'
                  ? 'cancelled'
                  : run.status === 'failed'
                    ? step.index === attempt.cursor
                      ? 'failed'
                      : 'cancelled'
                    : job?.state === 'completed'
                      ? run.waitReason === 'image_choice'
                        ? 'waiting'
                        : 'completed'
                      : 'queued'
    const endedAt =
      job?.completedAt ?? job?.endedAt ?? job?.expiredAt ?? step.endedAt
    const startedAt = job?.startedAt ?? step.startedAt
    const durationMs =
      job?.result?.durationMs ??
      (startedAt !== undefined && endedAt !== undefined
        ? Math.max(0, endedAt - startedAt)
        : undefined)
    const plate =
      projection?.plates[step.plateId]?.batchInput ?? job?.inputPlate
    const skippedPhases = job?.result
      ? job.result.skippedPhases
      : job?.skippedPhases
    return {
      index: step.index,
      plateId: step.plateId,
      plateName: plate?.displayName ?? step.plateId,
      ...(plate?.state ? { plateState: plate.state } : {}),
      stage: step.stage,
      status,
      ...(job?.phaseIndex !== undefined ? { phaseIndex: job.phaseIndex } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(job?.workerId ? { workerId: job.workerId } : {}),
      ...(job?.result?.servedByFallback
        ? { servedByFallback: job.result.model }
        : {}),
      ...(skippedPhases?.length ? { skippedPhases } : {}),
      ...((step.reason ?? job?.result?.stageError ?? job?.failure)
        ? { reason: step.reason ?? job?.result?.stageError ?? job?.failure }
        : {}),
    } satisfies StepProgress
  })
  const starts = (attempt.steps ?? []).flatMap((step) =>
    step.startedAt === undefined ? [] : [step.startedAt]
  )
  const currentJobs = run.jobs.filter(
    (job) => job.queueAttempt === attempt.number
  )
  return {
    steps,
    workerIds: [
      ...new Set(
        currentJobs.flatMap((job) => (job.workerId ? [job.workerId] : []))
      ),
    ],
    ...(starts.length ? { startedAt: Math.min(...starts) } : {}),
    ...(attempt.endedAt !== undefined ? { endedAt: attempt.endedAt } : {}),
    workflowUrl: attempt.workflowUrl,
  }
}

type PlateOutcome = {
  label: 'Passed' | 'Skipped' | 'Failed' | 'Cancelled'
  step?: StepProgress
}

export function plateOutcomes(
  steps: StepProgress[]
): Map<string, PlateOutcome> {
  const byPlate = Map.groupBy(
    steps.filter((step) => step.stage !== 'group'),
    (step) => step.plateId
  )
  return new Map(
    [...byPlate].flatMap<[string, PlateOutcome]>(([plateId, plateSteps]) => {
      const failed = plateSteps.find((step) => step.status === 'failed')
      const skipped = plateSteps.find((step) => step.status === 'skipped')
      if (failed)
        return [
          [
            plateId,
            {
              label: isPlateFailure(failed.reason) ? 'Skipped' : 'Failed',
              step: failed,
            },
          ],
        ]
      if (skipped) return [[plateId, { label: 'Skipped', step: skipped }]]
      if (plateSteps.some((step) => step.status === 'cancelled'))
        return [[plateId, { label: 'Cancelled' }]]
      if (plateSteps.every((step) => step.status === 'completed'))
        return [[plateId, { label: 'Passed' }]]
      return []
    })
  )
}

export function plateOutcomeSummary(steps: StepProgress[]): string {
  const outcomes = [...plateOutcomes(steps).values()]
  return ['Passed', 'Skipped', 'Failed', 'Cancelled']
    .flatMap((label) => {
      const count = outcomes.filter((outcome) => outcome.label === label).length
      return count ? [`${count} ${label.toLowerCase()}`] : []
    })
    .join(' · ')
}

/** Summarize a stage's steps using the status that needs the most attention. */
export function stageStatus(steps: StepProgress[]): StepProgress['status'] {
  if (!steps.length) return 'skipped'
  for (const status of [
    'running',
    'waiting',
    'queued',
    'failed',
    'cancelled',
  ] as const)
    if (steps.some((step) => step.status === status)) return status
  return steps.every((step) => step.status === 'skipped')
    ? 'skipped'
    : 'completed'
}

/**
 * Format nonnegative elapsed milliseconds for the queue UI and leave unknown durations
 * empty.
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—'
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}
