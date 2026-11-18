'use client'

import type { ReactNode } from 'react'
import { IoOpenOutline, IoCheckmark, IoClose, IoRemove } from 'react-icons/io5'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { LocalRunStage, RunStatus } from '@/lib/jobs/queue-types'
import { formatDuration, stageStatus, type PipelineProgress, type StepProgress } from '@/lib/jobs/run-progress'
import { pipelineStages } from './pipeline-stages'
import styles from './pipeline-runs.module.css'

const statusLabels = { completed: 'Complete', running: 'Running', queued: 'Waiting', waiting: 'Choose image', failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped' }
const reasons: Record<string, string> = { no_sources: 'No usable source page was found.', no_supported_fields: 'The source did not support a suggestion.', missing_wiki_link: 'The required Wiki link was not produced.', missing_description: 'The required description was not produced.', upstream_failed: 'An earlier step failed. This step did not run.', run_cancelled: 'The remaining work was cancelled.', unavailable: 'The worker cannot run this stage.' }

function StepList({ steps }: { steps: StepProgress[] }) {
  return <ul className={styles.stepList}>{steps.map(step => <li key={step.index}>
    <div><strong>{step.plateName}</strong><span data-status={step.status}>{statusLabels[step.status]}{step.durationMs !== undefined ? ` · ${formatDuration(step.durationMs)}` : ''}</span></div>
    {step.reason ? <p>{reasons[step.reason] ?? step.reason.replaceAll('_', ' ')}</p> : null}
  </li>)}</ul>
}

export function PipelineRunCard({ run, progress, stages, observedAt, requester, children }: {
  run: { id: string; requestedBy: string; plateIds: string[]; status: RunStatus; createdAt: number; batchName?: string }
  progress: PipelineProgress; stages: readonly LocalRunStage[]; observedAt?: number; requester?: string; children?: ReactNode
}) {
  const completed = progress.steps.filter(step => step.status === 'completed').length
  const percent = progress.steps.length ? Math.round(completed / progress.steps.length * 100) : 0
  const stopped = run.status === 'failed' || run.status === 'cancelled'
  const name = requester || run.requestedBy
  const elapsed = (progress.endedAt ?? observedAt) === undefined ? undefined : (progress.endedAt ?? observedAt!) - run.createdAt
  const reference = run.id.length > 12 ? run.id.slice(-8) : run.id
  const plates = [...new Map(progress.steps.map(step => [step.plateId, step.plateName])).entries()]
  return <article className={styles.run} data-run-status={run.status} aria-label={`Pipeline run ${reference}`}>
    <header className={styles.runHeader}>
      <span>Started by</span><span className={styles.avatar} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span><span className={styles.requester} title={name}>{name}</span>
      <span className={styles.reference} title={run.id}>Run {reference}</span>
      {progress.workflowUrl ? <Button asChild size="sm" variant="ghost"><a href={progress.workflowUrl} target="_blank" rel="noopener noreferrer" aria-label={`View workflow for run ${reference}`} title="Open Vercel Workflow Visibility UI (new tab)">View workflow<IoOpenOutline data-icon="inline-end" aria-hidden="true" /></a></Button>
        : <Button size="sm" variant="ghost" disabled title="No hosted Workflow Visibility link is recorded for this run.">View workflow</Button>}
      <span className={styles.batch}>{run.batchName}</span><span className={styles.elapsed}>Elapsed <b>{formatDuration(elapsed)}</b></span>
    </header>
    <div className={styles.scroll} role="region" aria-label={`Stages for run ${reference}; scroll horizontally`} tabIndex={0}>
      <div className={styles.flow}>
        <Popover><PopoverTrigger asChild><button type="button" className={styles.plates} aria-label={`View ${run.plateIds.length} plates in run ${reference}`}><strong>{run.plateIds.length}</strong><span>{run.plateIds.length === 1 ? 'plate' : 'plates'}</span></button></PopoverTrigger>
          <PopoverContent className="max-h-80 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"><h3 className="label">Plates in this run</h3><ul className={styles.stepList}>{(plates.length ? plates : run.plateIds.map(id => [id, id])).map(([id, name]) => <li key={id}>{name}</li>)}</ul></PopoverContent>
        </Popover>
        {stages.map((stage, index) => {
          const steps = progress.steps.filter(step => step.stage === stage)
          const status = stageStatus(steps)
          const label = pipelineStages.find(item => item.id === stage)?.label ?? stage
          const done = steps.filter(step => step.status === 'completed').length
          const timed = steps.filter(step => step.durationMs !== undefined)
          const duration = timed.length ? formatDuration(timed.reduce((sum, step) => sum + step.durationMs!, 0)) : null
          const timing = ['completed', 'failed'].includes(status) && duration ? ` · ${duration}` : status === 'cancelled' ? done ? ` · ${done}/${steps.length} complete` : ' · not run' : status === 'running' ? ` · ${done}/${steps.length}` : ''
          return <div className={styles.stageWrap} key={stage}>
            <span className={styles.connector} aria-hidden="true" />
            <Popover><PopoverTrigger asChild><button type="button" className={styles.stage} data-status={status} aria-label={`${label}: ${statusLabels[status]}${timing}. View plate details.`}>
              <span className={styles.mark} aria-hidden="true">{status === 'completed' ? <IoCheckmark /> : status === 'failed' ? <IoClose /> : status === 'cancelled' || status === 'skipped' ? <IoRemove /> : status === 'running' ? <span className={styles.spinner} /> : index + 1}</span>
              <span className={styles.stageCopy}><strong>{label}</strong><span>{statusLabels[status]}{timing}</span></span>
            </button></PopoverTrigger><PopoverContent className="max-h-96 w-96 max-w-[calc(100vw-2rem)] overflow-y-auto"><h3 className="label">{label}</h3>{steps.length ? <StepList steps={steps} /> : <p className="caption">No plates needed this stage with the saved run options.</p>}</PopoverContent></Popover>
          </div>
        })}
        <div className={styles.finish} data-status={run.status}><strong>{stopped ? 'Stopped' : run.status === 'completed' ? 'Finished' : `${percent}%`}</strong><span>{stopped ? `${progress.steps.filter(step => step.status === 'cancelled').length} cancelled` : run.status === 'completed' ? `${run.plateIds.length} plates` : 'overall'}</span></div>
      </div>
    </div>
    {!stopped && progress.steps.length ? <progress className={styles.progress} max={progress.steps.length} value={completed} aria-label={`Run ${reference} progress`} /> : null}
    {children ? <footer className={styles.actions}>{children}</footer> : null}
  </article>
}
