'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { IoArrowForward } from 'react-icons/io5'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { RunStatus } from '@/lib/jobs/queue-types'
import { formatDuration, type PipelineProgress } from '@/lib/jobs/run-progress'
import styles from './pipeline-runs.module.css'

type RailRun = { id: string; createdAt: number; queuedAt?: number; status: RunStatus }
const railOrder = { failed: 0, queued: 1, completed: 2, running: 3, cancelled: 4 }
const historyLabels = { completed: 'Finished', failed: 'Failed', cancelled: 'Cancelled', queued: 'Queued', running: 'Running' }

export function PipelineRunRail<T extends RailRun>({ runs, observedAt, progress, renderRun, renderHistory, historyHref }: {
  runs: T[]
  observedAt?: number
  progress: (run: T) => PipelineProgress
  renderRun: (run: T) => ReactNode
  renderHistory: (run: T) => ReactNode
  historyHref: (run: T) => string
}) {
  const recent = (run: T) => {
    const end = progress(run).endedAt
    return run.status === 'completed' && end !== undefined && observedAt !== undefined && observedAt - end < 6000
  }
  const rail = runs.filter(run => ['failed', 'queued', 'running'].includes(run.status) || recent(run))
    .sort((a, b) => railOrder[a.status] - railOrder[b.status] || (b.queuedAt ?? b.createdAt) - (a.queuedAt ?? a.createdAt) || a.id.localeCompare(b.id))
  const history = runs.filter(run => ['completed', 'failed', 'cancelled'].includes(run.status) && !recent(run))
    .sort((a, b) => (progress(b).endedAt ?? b.createdAt) - (progress(a).endedAt ?? a.createdAt))
  const summary = (['failed', 'queued', 'running', 'completed'] as const).flatMap(status => {
    const count = rail.filter(run => run.status === status).length
    return count ? [`${count} ${historyLabels[status].toLowerCase()}`] : []
  }).join(', ')
  return <TooltipProvider delayDuration={250}>
    <p className="sr-only" role="status">{summary ? `Plate Pipeline: ${summary}` : ''}</p>
    <div className={styles.rail} role="region" aria-label="Plate Pipeline runs, scroll horizontally" tabIndex={0}>
      <ol className={styles.runList}>{rail.map(run => <li key={run.id}>{renderRun(run)}</li>)}</ol>
      <Popover>
        <PopoverTrigger asChild><Button variant="outline" className={styles.history}>History<IoArrowForward aria-hidden="true" /></Button></PopoverTrigger>
        <PopoverContent align="end" collisionPadding={12} aria-label="Run history" className={styles.historyPanel}>
          <PopoverTitle>Run history</PopoverTitle>
          {history.length ? <ul className={styles.historyList}>{history.map(run => {
            const detail = progress(run)
            const end = detail.endedAt
            const inspector = detail.workflowUrl ?? detail.gatewayUrl
            return <li key={run.id}><details><summary>
              {inspector
                ? <a className="font-bold underline underline-offset-2" href={inspector} target="_blank" rel="noopener noreferrer">Run {run.id.slice(-8)}</a>
                : <Link className="font-bold underline-offset-2 hover:underline focus-visible:underline" href={historyHref(run)} prefetch={false}>Run {run.id.slice(-8)}</Link>}
              <span data-status={run.status}>{historyLabels[run.status]} · {formatDuration(end === undefined ? undefined : end - run.createdAt)}</span>
            </summary>{renderHistory(run)}</details></li>
          })}</ul> : <p className="caption">No finished runs yet.</p>}
        </PopoverContent>
      </Popover>
    </div>
  </TooltipProvider>
}
