import type { QueueRunSummary, QueueRunView, RunStatus } from './queue-types'
import type { LocalRunStage } from './queue-types'

export type StepProgress = {
  index: number
  plateId: string
  plateName: string
  stage: LocalRunStage
  status: RunStatus | 'waiting' | 'skipped'
  durationMs?: number
  reason?: string
}
export type PipelineProgress = {
  steps: StepProgress[]
  workerIds: string[]
  startedAt?: number
  endedAt?: number
  workflowUrl?: string | null
}

export function queueProgress(run: QueueRunView | QueueRunSummary): PipelineProgress {
  const attempt = run.attempts.at(-1)!
  const projection = 'projection' in attempt ? attempt.projection : undefined
  const steps = (attempt.steps ?? []).map(step => {
    const completedId = attempt.completedJobIds?.[step.index]
    const job = run.jobs.find(job => job.id === completedId) ?? run.jobs.find(job => job.queueAttempt === attempt.number && job.queueStep === step.index)
    const status = step.status === 'cancelled' ? 'cancelled'
      : job?.result?.stageError || job?.state === 'failed' || job?.state === 'expired' ? 'failed'
        : step.status === 'failed' ? 'failed'
          : completedId || step.index < attempt.cursor ? 'completed'
            : job?.state === 'claimed' ? 'running'
              : job?.state === 'cancelled' || run.status === 'cancelled' ? 'cancelled'
                : run.status === 'failed' ? step.index === attempt.cursor ? 'failed' : 'cancelled'
                  : job?.state === 'completed' ? run.waitReason === 'image_choice' ? 'waiting' : 'completed' : 'queued'
    const endedAt = job?.completedAt ?? job?.endedAt ?? job?.expiredAt ?? step.endedAt
    const startedAt = job?.startedAt ?? step.startedAt
    const durationMs = job?.result?.durationMs ?? (startedAt !== undefined && endedAt !== undefined ? Math.max(0, endedAt - startedAt) : undefined)
    return {
      index: step.index, plateId: step.plateId, plateName: projection?.plates[step.plateId]?.batchInput.displayName ?? job?.inputPlate?.displayName ?? step.plateId,
      stage: step.stage, status, ...(durationMs !== undefined ? { durationMs } : {}),
      ...((step.reason ?? job?.result?.stageError ?? job?.failure) ? { reason: step.reason ?? job?.result?.stageError ?? job?.failure } : {}),
    } satisfies StepProgress
  })
  const starts = (attempt.steps ?? []).flatMap(step => step.startedAt === undefined ? [] : [step.startedAt])
  const currentJobs = run.jobs.filter(job => job.queueAttempt === attempt.number)
  return { steps, workerIds: [...new Set(currentJobs.flatMap(job => job.workerId ? [job.workerId] : []))],
    ...(starts.length ? { startedAt: Math.min(...starts) } : {}),
    ...(attempt.endedAt !== undefined ? { endedAt: attempt.endedAt } : {}), workflowUrl: attempt.workflowUrl }
}

export function stageStatus(steps: StepProgress[]): StepProgress['status'] {
  if (!steps.length) return 'skipped'
  for (const status of ['failed', 'running', 'waiting', 'queued', 'cancelled'] as const) if (steps.some(step => step.status === status)) return status
  return 'completed'
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—'
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}
