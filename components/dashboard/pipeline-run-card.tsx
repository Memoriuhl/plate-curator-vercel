'use client'

import { useId, useState, type ReactNode } from 'react'
import Link from 'next/link'
import {
  IoCheckmark,
  IoChevronDown,
  IoClose,
  IoEllipseOutline,
  IoEyeOutline,
  IoGitBranchOutline,
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
import { PipelinePlateList, PipelinePlateStack } from './pipeline-run-plates'
import type { LocalRunStage, RunStatus } from '@/lib/jobs/queue-types'
import {
  formatDuration,
  plateOutcomeSummary,
  stageStatus,
  type PipelineProgress,
  type StepProgress,
} from '@/lib/jobs/run-progress'
import { pipelineStepReason, pipelineStages } from './pipeline-stages'
import { PlatePipelineTimeline } from './plate-pipeline-timeline'
import { machineLabels, type RunExecution } from './pipeline-run-execution'
import type { RunDisclosure } from './pipeline-run-rail'
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
  execution,
  resultsHref,
  stageResultsHref,
  onStageResults,
  attempt,
  runAction,
  waitLabel,
  waitingForWorker,
  disclosure,
}: {
  run: {
    id: string
    requestedBy: string
    plateIds: string[]
    batchId?: string
    batchName?: string
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
  execution?: RunExecution[]
  resultsHref?: string
  runAction?: ReactNode
  waitLabel?: string
  disclosure?: RunDisclosure
  waitingForWorker?: boolean
  stageResultsHref?: (stage: LocalRunStage) => string
  attempt?: { number: number; error?: string }
  onStageResults?: (stage: LocalRunStage, trigger: HTMLButtonElement) => void
}) {
  const overviewId = useId()
  const summary =
    !disclosure || disclosure.expanded
      ? plateOutcomeSummary(progress.steps)
      : ''
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
  const name = requester || run.requestedBy
  const clock = progress.endedAt ?? observedAt
  const runStatus =
    runOutcome ?? (partial ? 'Finished with issues' : statusLabels[run.status])
  const fallbackModels = [
    ...new Set(
      progress.steps.flatMap(({ servedByFallback }) =>
        servedByFallback ? [servedByFallback] : []
      )
    ),
  ]
  const reference = run.id.length > 12 ? run.id.slice(-8) : run.id
  const inspector = progress.workflowUrl ?? progress.gatewayUrl
  const inspectorLabel = progress.workflowUrl
    ? progress.workflowUrl.startsWith('https://vercel.com/')
      ? 'Show Vercel workflow run'
      : 'Show workflow run'
    : 'Show Vercel AI Gateway logs'
  const header = (
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
          <TooltipContent collisionPadding={12} className={styles.stageTooltip}>
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
            {attempt?.error && <span>{pipelineStepReason(attempt.error)}</span>}
          </TooltipContent>
        </Tooltip>
      </div>
      {!disclosure && fallbackModels.length > 0 && (
        <span className="caption">
          Served by fallback · {fallbackModels.join(', ')}
        </span>
      )}
      {runAction && <div className={styles.runTools}>{runAction}</div>}
    </header>
  )

  if (disclosure) {
    const failed =
      run.status === 'completed' &&
      progress.steps.some((step) => step.status === 'failed')
    const needsInput = progress.steps.some((step) => step.status === 'waiting')
    const indicator = allSkipped
      ? 'skipped'
      : failed
        ? 'failed'
        : needsInput
          ? 'waiting'
          : waitingForWorker
            ? 'pickup'
            : run.status
    const label =
      runOutcome ??
      (failed
        ? 'Finished with issues'
        : needsInput
          ? 'Needs input'
          : waitingForWorker
            ? 'Waiting'
            : run.status === 'completed'
              ? 'Finished'
              : run.status === 'queued'
                ? 'Queued'
                : runStatus)
    const pickupStage = waitingForWorker
      ? (progress.steps.find((step) => step.status === 'queued')?.stage ??
        stages[0])
      : undefined
    const definitions = stages.map((stage) =>
      pipelineStages.find((item) => item.id === stage)
    )
    const pipelineName =
      stages
        .map((stage, index) => definitions[index]?.label ?? stage)
        .join(' + ') || 'Plate pipeline'
    const PipelineIcon =
      (stages.length === 1 ? definitions[0]?.icon : undefined) ??
      IoGitBranchOutline
    return (
      <article
        className={styles.compactRun}
        aria-label={`Pipeline run ${reference}`}
      >
        <button
          type="button"
          className={styles.runToggle}
          data-status={indicator}
          aria-expanded={disclosure.expanded}
          aria-controls={overviewId}
          onClick={disclosure.onToggle}
        >
          <span className={styles.pipelineIcon}>
            <PipelineIcon aria-hidden="true" />
          </span>
          <span className={styles.runTitle}>
            <strong>{pipelineName}</strong>
            <span className={styles.runMetadata}>
              <span>
                {run.batchName ?? `Run ${reference}`} ·{' '}
                <span className={styles.runPlateCount}>
                  {run.plateIds.length}{' '}
                  {run.plateIds.length === 1 ? 'plate' : 'plates'}
                </span>
              </span>
              {fallbackModels.length > 0 && (
                <span>Served by fallback · {fallbackModels.join(', ')}</span>
              )}
              {execution?.map(({ machine, models }) => (
                <span key={machine}>
                  {machineLabels[machine]}
                  {models.length ? ` · ${models.join(' + ')}` : ''}
                </span>
              ))}
            </span>
          </span>
          <span className={styles.overviewStatus}>
            <StageMark status={indicator} />
            {label}
          </span>
          <IoChevronDown
            className={styles.overviewChevron}
            aria-hidden="true"
          />
        </button>
        <div
          id={overviewId}
          hidden={!disclosure.expanded}
          className={styles.runOverview}
        >
          {disclosure.expanded && (
            <>
              {header}
              <RunStageList
                stages={stages}
                steps={progress.steps}
                pickupStage={pickupStage}
                stageResultsHref={stageResultsHref}
                onStageResults={onStageResults}
              />
              {waitLabel && (
                <p className={styles.overviewNote} role="status">
                  {waitLabel}
                </p>
              )}
              {children && (
                <div className={styles.overviewNote}>{children}</div>
              )}
              <RunPlateDetails
                running={run.status === 'running'}
                plateIds={run.plateIds}
                batchId={run.batchId}
                progress={progress}
                plates={plates}
                resultsHref={resultsHref}
              />
            </>
          )}
        </div>
      </article>
    )
  }
  const settled = progress.steps.filter((step) =>
    ['completed', 'skipped', 'failed', 'cancelled'].includes(step.status)
  ).length
  const stopped =
    run.status === 'failed' || run.status === 'cancelled' || allSkipped

  return (
    <article
      className={styles.run}
      data-run-status={run.status}
      aria-label={`Pipeline run ${reference}`}
    >
      {header}
      <div className={styles.flow} data-pipeline-flow>
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
                <StageMark status={status} number={index + 1} />
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

function StageMark({
  status,
  number,
}: {
  status: StepProgress['status'] | 'pickup'
  number?: number
}) {
  return (
    <span className={styles.mark} aria-hidden="true">
      {status === 'completed' ? (
        <IoCheckmark />
      ) : status === 'failed' ? (
        <IoClose />
      ) : status === 'cancelled' || status === 'skipped' ? (
        <IoRemove />
      ) : status === 'running' ? (
        <span className={styles.spinner} />
      ) : status === 'pickup' ? (
        <span className={styles.pickupDot} />
      ) : (
        (number ?? <IoEllipseOutline />)
      )}
    </span>
  )
}

const countLabels = {
  completed: 'done',
  running: 'running',
  failed: 'failed',
  waiting: 'need input',
  queued: 'queued',
} as const

function RunStageList({
  stages,
  steps,
  stageResultsHref,
  onStageResults,
  pickupStage,
}: {
  stages: readonly LocalRunStage[]
  steps: StepProgress[]
  pickupStage?: LocalRunStage
  stageResultsHref?: (stage: LocalRunStage) => string
  onStageResults?: (stage: LocalRunStage, trigger: HTMLButtonElement) => void
}) {
  const byStage = Map.groupBy(steps, (step) => step.stage)
  const highlights = (['running', 'waiting', 'failed'] as const).map((status) =>
    steps.find((step) => step.status === status)
  )
  return (
    <ol className={styles.overviewStages} aria-label="Run stages">
      {stages.map((stage) => {
        const stageSteps = byStage.get(stage) ?? []
        const status = stageSteps.length ? stageStatus(stageSteps) : 'queued'
        const waiting = pickupStage === stage
        const indicator = waiting
          ? 'pickup'
          : status === 'queued' &&
              stageSteps.some((step) => step.status === 'failed')
            ? 'failed'
            : status
        const definition = pipelineStages.find((item) => item.id === stage)
        const label = definition?.label ?? stage
        const counts = (
          Object.keys(countLabels) as (keyof typeof countLabels)[]
        )
          .flatMap((state) => {
            const count = stageSteps.filter(
              (step) => step.status === state
            ).length
            return count ? [`${count} ${countLabels[state]}`] : []
          })
          .join(' · ')
        const needsInput = stageSteps.some((step) => step.status === 'waiting')
        const canViewResults =
          needsInput ||
          (stageSteps.length > 0 && status !== 'running' && status !== 'queued')
        const outcomeHref = canViewResults
          ? stageResultsHref?.(stage)
          : undefined
        const outcomeLabel = needsInput
          ? `Choose image for ${label}`
          : `View ${label} results`
        const resultLabel = needsInput ? (
          'Choose image'
        ) : (
          <IoEyeOutline aria-hidden="true" />
        )
        return (
          <li
            key={stage}
            className={styles.overviewStage}
            data-status={indicator}
          >
            <StageMark status={indicator} />
            <div className={styles.overviewStageCopy}>
              <strong>{label}</strong>
              {(waiting || counts) && (
                <span className={styles.stageCounts}>
                  {waiting ? (
                    <>
                      <span className={styles.pickupLabel}>Waiting</span>
                      {counts && ` · ${counts}`}
                    </>
                  ) : (
                    counts
                  )}
                </span>
              )}
              {highlights.map((step) => {
                if (step?.stage !== stage) return null
                const detail =
                  step.status === 'failed'
                    ? step.reason
                      ? pipelineStepReason(step.reason)
                      : 'Step failed'
                    : step.status === 'waiting'
                      ? 'Waiting for image selection'
                      : (definition?.flow?.[step.phaseIndex ?? 0]?.label ??
                        'Running')
                return (
                  <span
                    key={step.index}
                    className={styles.stageHighlight}
                    data-status={step.status}
                  >
                    <span>{step.plateName}</span>
                    <span>{detail}</span>
                  </span>
                )
              })}
            </div>
            {canViewResults &&
              (onStageResults ? (
                <button
                  type="button"
                  className={styles.overviewResult}
                  aria-label={outcomeLabel}
                  title={outcomeLabel}
                  onClick={(event) =>
                    onStageResults(stage, event.currentTarget)
                  }
                >
                  {resultLabel}
                </button>
              ) : (
                outcomeHref && (
                  <Link
                    href={outcomeHref}
                    className={styles.overviewResult}
                    aria-label={outcomeLabel}
                    title={outcomeLabel}
                    prefetch={false}
                  >
                    {resultLabel}
                  </Link>
                )
              ))}
          </li>
        )
      })}
    </ol>
  )
}

function RunPlateDetails({
  running,
  plateIds,
  batchId,
  progress,
  plates,
  resultsHref,
}: {
  running: boolean
  plateIds: string[]
  batchId?: string
  progress: PipelineProgress
  plates?: RunPlateDetail[]
  resultsHref?: string
}) {
  const [visibility, setVisibility] = useState({ running, open: running })
  const id = useId()
  const { open } = visibility
  if (visibility.running !== running)
    setVisibility({ running, open: running || open })
  if (!plateIds.length) return null
  return (
    <div className={styles.overviewPlates}>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={styles.plateToggle}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setVisibility({ running, open: !open })}
      >
        {open ? 'Hide plates' : 'View plates'}
        <IoChevronDown aria-hidden="true" />
      </Button>
      <div id={id} hidden={!open}>
        {open && (
          <>
            {progress.steps.some((step) => step.stage !== 'group') ? (
              <PlatePipelineTimeline
                steps={progress.steps}
                batchId={batchId}
                images={progress.plateImages}
                plates={plates}
              />
            ) : (
              <PipelinePlateList
                plateIds={plateIds}
                steps={progress.steps}
                plates={plates}
              />
            )}
            {resultsHref && (
              <Button asChild size="sm" variant="ghost">
                <Link href={resultsHref} prefetch={false}>
                  Open run details
                </Link>
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
