'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import {
  IoCheckmark,
  IoClose,
  IoEyeOutline,
  IoInformationCircleOutline,
  IoRemove,
} from 'react-icons/io5'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { RunPlateDetail } from '@/lib/jobs/run-plates'
import { PipelinePlateStack } from './pipeline-run-plates'
import type { LocalRunStage, RunStatus } from '@/lib/jobs/queue-types'
import {
  formatDuration,
  plateOutcomeSummary,
  stageStatus,
  type PipelineProgress,
} from '@/lib/jobs/run-progress'
import { pipelineStepReason, pipelineStages } from './pipeline-stages'
import { PlatePipelineTimeline } from './plate-pipeline-timeline'
import styles from './pipeline-runs.module.css'

const statusLabels = {
  completed: 'Complete',
  running: 'Running',
  queued: 'Waiting',
  waiting: 'Choose image',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
}

/** Render a run's progress, timing and action details in the shared pipeline card. */
export function PipelineRunCard({
  run,
  progress,
  stages,
  observedAt,
  requester,
  children,
  local,
  plates,
  device,
  resultsHref,
  stageResultsHref,
  attempt,
  runAction,
  waitLabel,
}: {
  run: {
    id: string
    requestedBy: string
    plateIds: string[]
    batchId?: string
    status: RunStatus
    createdAt: number
  }
  progress: PipelineProgress
  stages: readonly LocalRunStage[]
  observedAt?: number
  requester?: string
  children?: ReactNode
  local?: boolean
  plates?: RunPlateDetail[]
  device?: string
  resultsHref?: string
  runAction?: ReactNode
  waitLabel?: string
  stageResultsHref?: (stage: LocalRunStage) => string
  attempt?: { number: number; error?: string }
}) {
  const settled = progress.steps.filter((step) =>
    ['completed', 'skipped', 'failed', 'cancelled'].includes(step.status)
  ).length
  const summary = plateOutcomeSummary(progress.steps)
  const partial =
    run.status === 'completed' &&
    progress.steps.some(
      (step) => step.status === 'failed' || step.status === 'skipped'
    )
  const allSkipped =
    run.status === 'completed' &&
    progress.steps.length > 0 &&
    progress.steps.every((step) => step.status === 'skipped')
  const runOutcome =
    run.status === 'cancelled' ? 'Canceled' : allSkipped ? 'Skipped' : undefined
  const stopped =
    run.status === 'failed' || run.status === 'cancelled' || allSkipped
  const name = requester || run.requestedBy
  const clock = progress.endedAt ?? observedAt
  const runStatus =
    runOutcome ?? (partial ? 'Finished with issues' : statusLabels[run.status])
  const reference = run.id.length > 12 ? run.id.slice(-8) : run.id
  const inspector = progress.workflowUrl ?? progress.gatewayUrl
  const inspectorLabel = progress.workflowUrl
    ? progress.workflowUrl.startsWith('https://vercel.com/')
      ? 'Show Vercel workflow run'
      : 'Show workflow run'
    : 'Show Vercel AI Gateway logs'
  return (
    <article
      className={styles.run}
      data-run-status={run.status}
      aria-label={`Pipeline run ${reference}`}
    >
      <header className={styles.runHeader}>
        <div className={styles.runIdentity}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={styles.avatar}
                aria-label={`Started by ${name}`}
              >
                <span aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent collisionPadding={12}>
              Started by {name}
            </TooltipContent>
          </Tooltip>
          {inspector ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  className={styles.reference}
                  href={inspector}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Run {reference}
                </a>
              </TooltipTrigger>
              <TooltipContent collisionPadding={12}>
                {inspectorLabel}
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className={styles.reference} title={run.id}>
              Run {reference}
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8"
                aria-label="Run activity"
              >
                <IoInformationCircleOutline aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent
              collisionPadding={12}
              className={styles.stageTooltip}
            >
              <strong>Run activity</strong>
              <span>
                {runStatus}
                {attempt && ` · Attempt ${attempt.number}`}
              </span>
              <span>Requested {new Date(run.createdAt).toLocaleString()}</span>
              {progress.endedAt !== undefined && (
                <span>
                  Finished {new Date(progress.endedAt).toLocaleString()}
                </span>
              )}
              {clock !== undefined && (
                <span>Elapsed {formatDuration(clock - run.createdAt)}</span>
              )}
              {summary && <span>{summary}</span>}
              {attempt?.error && (
                <span>{pipelineStepReason(attempt.error)}</span>
              )}
            </TooltipContent>
          </Tooltip>
        </div>
        {runAction && <div className={styles.runTools}>{runAction}</div>}
      </header>
      <div className={styles.flow}>
        <PipelinePlateStack
          runId={run.id}
          plateIds={run.plateIds}
          steps={progress.steps}
          plates={plates}
          local={local}
          resultsHref={resultsHref}
          watchUrl={progress.workflowUrl}
        />
        {stages.map((stage, index) => {
          const steps = progress.steps.filter((step) => step.stage === stage)
          const status = stageStatus(steps)
          const definition = pipelineStages.find((item) => item.id === stage)
          const label = definition?.label ?? stage
          const workers = [
            ...new Set(
              steps.flatMap((step) => (step.workerId ? [step.workerId] : []))
            ),
          ]
          const explanations = [
            ...new Set(
              steps.flatMap((step) => {
                const reason =
                  step.reason ??
                  (step.status === 'cancelled'
                    ? run.status === 'failed'
                      ? 'upstream_failed'
                      : 'run_cancelled'
                    : undefined)
                return reason ? [pipelineStepReason(reason)] : []
              })
            ),
          ]
          const done = steps.filter(
            (step) => step.status === 'completed'
          ).length
          const counts = (
            ['completed', 'failed', 'skipped', 'cancelled'] as const
          ).flatMap((state) => {
            const count = steps.filter((step) => step.status === state).length
            return count
              ? [`${count} ${state === 'completed' ? 'passed' : state}`]
              : []
          })
          const breakdown = counts.length > 1 ? counts.join(' · ') : ''
          const canViewResult =
            steps.length > 0 && status !== 'running' && status !== 'queued'
          const outcomeHref = canViewResult
            ? stageResultsHref?.(stage)
            : undefined
          const outcomeLabel =
            status === 'waiting'
              ? `Choose image for ${label}`
              : `View ${label} results`
          const timed = steps.filter((step) => step.durationMs !== undefined)
          const duration = timed.length
            ? formatDuration(
                timed.reduce((sum, step) => sum + step.durationMs!, 0)
              )
            : null
          const timing =
            ['completed', 'failed'].includes(status) && duration
              ? ` · ${duration}`
              : status === 'cancelled'
                ? done
                  ? ` · ${done}/${steps.length} complete`
                  : ' · not run'
                : status === 'running'
                  ? ` · ${done}/${steps.length}`
                  : ''
          const showStatus =
            status === 'running' || status === 'waiting' || status === 'queued'
          const stageContent = (
            <span className={styles.stageCopy}>
              <span className={styles.stageTitle}>
                <span className={styles.mark} aria-hidden="true">
                  {status === 'completed' ? (
                    <IoCheckmark />
                  ) : status === 'failed' ? (
                    <IoClose />
                  ) : status === 'cancelled' || status === 'skipped' ? (
                    <IoRemove />
                  ) : status === 'running' ? (
                    <span className={styles.spinner} />
                  ) : (
                    index + 1
                  )}
                </span>
                <strong>{label}</strong>
                {outcomeHref && (
                  <IoEyeOutline
                    className={styles.stageResultIcon}
                    aria-hidden="true"
                  />
                )}
              </span>
              {showStatus && (
                <span className={styles.stageState}>
                  {statusLabels[status]}
                </span>
              )}
            </span>
          )
          return (
            <div className={styles.stageWrap} key={stage}>
              <span className={styles.connector} aria-hidden="true" />
              <Tooltip>
                <TooltipTrigger asChild>
                  {outcomeHref ? (
                    <Link
                      href={outcomeHref}
                      className={styles.stage}
                      data-status={status}
                      aria-label={outcomeLabel}
                      prefetch={false}
                    >
                      {stageContent}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className={styles.stage}
                      data-status={status}
                      aria-label={`${label}: ${statusLabels[status]}. Stage details.`}
                    >
                      {stageContent}
                    </button>
                  )}
                </TooltipTrigger>
                <TooltipContent
                  collisionPadding={12}
                  className={styles.stageTooltip}
                >
                  <strong>{label}</strong>
                  {definition ? <span>{definition.description}</span> : null}
                  <span>
                    {statusLabels[status]}
                    {timing}
                  </span>
                  {breakdown && <span>{breakdown}</span>}
                  {workers.length || device ? (
                    <span>Worker: {workers.join(', ') || device}</span>
                  ) : null}
                  {explanations.map((reason) => (
                    <span key={reason}>{reason}</span>
                  ))}
                  {outcomeHref && <strong>{outcomeLabel}</strong>}
                </TooltipContent>
              </Tooltip>
            </div>
          )
        })}
      </div>
      {!stopped && progress.steps.length ? (
        <progress
          className={styles.progress}
          max={progress.steps.length}
          value={settled}
          aria-label={`Run ${reference} progress`}
        />
      ) : null}
      <PlatePipelineTimeline
        steps={progress.steps}
        batchId={run.batchId}
        images={progress.plateImages}
        plates={plates}
      />
      {waitLabel && (
        <p className="caption" role="status">
          {waitLabel}
        </p>
      )}
      {(runOutcome || children) && (
        <footer className={styles.actions}>
          {runOutcome && (
            <span className={styles.runOutcome}>{runOutcome}</span>
          )}
          {children}
        </footer>
      )}
    </article>
  )
}
