'use client'

import type { ReactNode } from 'react'
import { IoCheckmark, IoClose, IoRemove } from 'react-icons/io5'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { RunPlateDetail } from '@/lib/jobs/run-plates'
import { PipelinePlateStack } from './pipeline-run-plates'
import type { LocalRunStage, RunStatus } from '@/lib/jobs/queue-types'
import { formatDuration, plateOutcomeSummary, stageStatus, type PipelineProgress } from '@/lib/jobs/run-progress'
import { pipelineStepReason, pipelineStages } from './pipeline-stages'
import { PlatePipelineTimeline } from './plate-pipeline-timeline'
import styles from './pipeline-runs.module.css'

const statusLabels = { completed: 'Complete', running: 'Running', queued: 'Waiting', waiting: 'Choose image', failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped' }

/** Render a run's progress, timing and action details in the shared pipeline card. */
export function PipelineRunCard({ run, progress, stages, observedAt, requester, children, local, plates, device, resultsHref, runAction, waitLabel }: {
  run: { id: string; requestedBy: string; plateIds: string[]; batchId?: string; status: RunStatus; createdAt: number }
  progress: PipelineProgress; stages: readonly LocalRunStage[]; observedAt?: number; requester?: string; children?: ReactNode
  local?: boolean; plates?: RunPlateDetail[]; device?: string; resultsHref?: string; runAction?: ReactNode; waitLabel?: string
}) {
  const settled = progress.steps.filter(step => ['completed', 'skipped', 'failed', 'cancelled'].includes(step.status)).length
  const percent = progress.steps.length ? Math.round(settled / progress.steps.length * 100) : 0
  const summary = plateOutcomeSummary(progress.steps)
  const partial = run.status === 'completed' && progress.steps.some(step => step.status === 'failed' || step.status === 'skipped')
  const stopped = run.status === 'failed' || run.status === 'cancelled'
  const name = requester || run.requestedBy
  const elapsed = (progress.endedAt ?? observedAt) === undefined ? undefined : (progress.endedAt ?? observedAt!) - run.createdAt
  const reference = run.id.length > 12 ? run.id.slice(-8) : run.id
  const inspector = progress.workflowUrl ?? progress.gatewayUrl
  return <article className={styles.run} data-run-status={run.status} aria-label={`Pipeline run ${reference}`}>
    <header className={styles.runHeader}>
      <span>Started by</span><span className={styles.avatar} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span><span className={styles.requester} title={name}>{name}</span>
      {inspector
        ? <a className={styles.reference} href={inspector} target="_blank" rel="noopener noreferrer" title={run.id}>Run {reference}</a>
        : <span className={styles.reference} title={run.id}>Run {reference}</span>}
      <span className={styles.elapsed}>Elapsed <b>{formatDuration(elapsed)}</b></span>
      {runAction}
    </header>
    <div className={styles.flow}>
      <PipelinePlateStack runId={run.id} plateIds={run.plateIds} steps={progress.steps} plates={plates} local={local} resultsHref={resultsHref} watchUrl={progress.workflowUrl} />
      {stages.map((stage, index) => {
        const steps = progress.steps.filter(step => step.stage === stage)
        const status = stageStatus(steps)
        const definition = pipelineStages.find(item => item.id === stage)
        const label = definition?.label ?? stage
        const workers = [...new Set(steps.flatMap(step => step.workerId ? [step.workerId] : []))]
        const explanations = [...new Set(steps.flatMap(step => {
          const reason = step.reason ?? (step.status === 'cancelled' ? (run.status === 'failed' ? 'upstream_failed' : 'run_cancelled') : undefined)
          return reason ? [pipelineStepReason(reason)] : []
        }))]
        const done = steps.filter(step => step.status === 'completed').length
        const counts = (['completed', 'failed', 'skipped', 'cancelled'] as const).flatMap(state => {
          const count = steps.filter(step => step.status === state).length
          return count ? [`${count} ${state === 'completed' ? 'passed' : state}`] : []
        })
        const breakdown = counts.length > 1 ? counts.join(' · ') : ''
        const active = status === 'running' || status === 'waiting' || status === 'queued'
        const timed = steps.filter(step => step.durationMs !== undefined)
        const duration = timed.length ? formatDuration(timed.reduce((sum, step) => sum + step.durationMs!, 0)) : null
        const timing = ['completed', 'failed'].includes(status) && duration ? ` · ${duration}` : status === 'cancelled' ? done ? ` · ${done}/${steps.length} complete` : ' · not run' : status === 'running' ? ` · ${done}/${steps.length}` : ''
        return <div className={styles.stageWrap} key={stage}>
          <span className={styles.connector} aria-hidden="true" />
          <Tooltip><TooltipTrigger asChild><button type="button" className={styles.stage} data-status={status} aria-label={`${label}: ${statusLabels[status]}${timing}.${breakdown ? ` ${breakdown}.` : ''} Stage details.`}>
            <span className={styles.mark} aria-hidden="true">{status === 'completed' ? <IoCheckmark /> : status === 'failed' ? <IoClose /> : status === 'cancelled' || status === 'skipped' ? <IoRemove /> : status === 'running' ? <span className={styles.spinner} /> : index + 1}</span>
            <span className={styles.stageCopy}><strong>{label}</strong><span>{!active && breakdown ? breakdown : `${statusLabels[status]}${timing}`}</span></span>
          </button></TooltipTrigger><TooltipContent collisionPadding={12} className={styles.stageTooltip}>
            <strong>{label}</strong>
            {definition ? <span>{definition.description}</span> : null}
            <span>{statusLabels[status]}{timing}</span>
            {breakdown && <span>{breakdown}</span>}
            {workers.length || device ? <span>Worker: {workers.join(', ') || device}</span> : null}
            {explanations.map(reason => <span key={reason}>{reason}</span>)}
          </TooltipContent></Tooltip>
        </div>
      })}
      <div className={styles.finish} data-status={run.status}><strong>{stopped ? 'Stopped' : run.status === 'completed' ? partial ? 'Finished with issues' : 'Finished' : run.status === 'queued' ? 'Queued' : `${percent}%`}</strong><span>{stopped || run.status === 'completed' ? summary || `${run.plateIds.length} plates` : run.status === 'queued' ? 'Waiting' : 'overall'}</span></div>
    </div>
    {!stopped && progress.steps.length ? <progress className={styles.progress} max={progress.steps.length} value={settled} aria-label={`Run ${reference} progress`} /> : null}
    {local && progress.steps.length > 0 && <PlatePipelineTimeline steps={progress.steps} batchId={run.batchId} images={progress.plateImages} />}
    {waitLabel && <p className="caption" role="status">{waitLabel}</p>}
    {children ? <footer className={styles.actions}>{children}</footer> : null}
  </article>
}
