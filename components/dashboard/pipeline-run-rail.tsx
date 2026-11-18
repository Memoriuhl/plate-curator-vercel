'use client'

import { useLayoutEffect, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { IoArrowForward } from 'react-icons/io5'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { RunStatus } from '@/lib/jobs/queue-types'
import { formatDuration, type PipelineProgress } from '@/lib/jobs/run-progress'
import styles from './pipeline-runs.module.css'

type RailRun = {
  id: string
  createdAt: number
  queuedAt?: number
  enqueueSequence?: number
  dismissedAt?: number
  status: RunStatus
}
const historyLabels = {
  completed: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  queued: 'Queued',
  running: 'Running',
}

export function PipelineRailSkeleton({
  compact = false,
}: {
  compact?: boolean
}) {
  return (
    <div
      className={styles.railSkeleton}
      data-compact={compact || undefined}
      role="status"
      aria-label="Loading pipeline runs"
    >
      {[0, 1].map((index) => (
        <div key={index} className={styles.runSkeleton} aria-hidden="true">
          <span />
          <div>
            <span />
            <span />
            <span />
          </div>
          {!compact && (
            <section>
              <span />
              <span />
              <span />
            </section>
          )}
          <span />
        </div>
      ))}
    </div>
  )
}

/** Show undismissed pipeline runs in enqueue order alongside run history. */
export function PipelineRunRail<T extends RailRun>({
  runs,
  includeFinishedInHistory,
  progress,
  renderRun,
  renderHistory,
  historyHref,
}: {
  runs: T[]
  includeFinishedInHistory?: boolean
  progress: (run: T) => PipelineProgress
  renderRun: (run: T) => ReactNode
  renderHistory: (run: T) => ReactNode
  historyHref: (run: T) => string
}) {
  const rail = runs
    .filter((run) => run.dismissedAt === undefined)
    .sort(
      (a, b) =>
        (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt) ||
        (a.enqueueSequence ?? 0) - (b.enqueueSequence ?? 0) ||
        a.id.localeCompare(b.id)
    )
  const history = runs
    .filter(
      (run) =>
        (includeFinishedInHistory || run.dismissedAt !== undefined) &&
        ['completed', 'failed', 'cancelled'].includes(run.status)
    )
    .sort(
      (a, b) =>
        (progress(b).endedAt ?? b.createdAt) -
        (progress(a).endedAt ?? a.createdAt)
    )
  const viewport = useRef<HTMLDivElement>(null)
  const newestId = rail.at(-1)?.id
  useLayoutEffect(() => {
    const element = viewport.current
    if (element) element.scrollLeft = element.scrollWidth
  }, [newestId])
  const summary = (
    ['failed', 'queued', 'running', 'completed', 'cancelled'] as const
  )
    .flatMap((status) => {
      const count = rail.filter((run) => run.status === status).length
      return count ? [`${count} ${historyLabels[status].toLowerCase()}`] : []
    })
    .join(', ')
  return (
    <TooltipProvider delayDuration={250}>
      <p className="sr-only" role="status">
        {summary ? `Plate Pipeline: ${summary}` : ''}
      </p>
      <div className={styles.railBar}>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className={styles.history}>
              History
              <IoArrowForward aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            collisionPadding={12}
            aria-label="Run history"
            className={styles.historyPanel}
          >
            <PopoverTitle>Run history</PopoverTitle>
            {history.length ? (
              <ul className={styles.historyList}>
                {history.map((run) => {
                  const detail = progress(run)
                  const end = detail.endedAt
                  const inspector = detail.workflowUrl ?? detail.gatewayUrl
                  return (
                    <li key={run.id}>
                      <details>
                        <summary>
                          {inspector ? (
                            <a
                              className="font-bold underline underline-offset-2"
                              href={inspector}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Run {run.id.slice(-8)}
                            </a>
                          ) : (
                            <Link
                              className="font-bold underline-offset-2 hover:underline focus-visible:underline"
                              href={historyHref(run)}
                              prefetch={false}
                            >
                              Run {run.id.slice(-8)}
                            </Link>
                          )}
                          <span data-status={run.status}>
                            {historyLabels[run.status]} ·{' '}
                            {formatDuration(
                              end === undefined
                                ? undefined
                                : end - run.createdAt
                            )}
                          </span>
                        </summary>
                        {renderHistory(run)}
                      </details>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="caption">No finished runs yet.</p>
            )}
          </PopoverContent>
        </Popover>
        <div
          ref={viewport}
          className={styles.rail}
          role="region"
          aria-label="Plate Pipeline runs, scroll horizontally"
          tabIndex={0}
        >
          {rail.length ? (
            <ol className={styles.runList}>
              {rail.map((run) => (
                <li key={run.id}>{renderRun(run)}</li>
              ))}
            </ol>
          ) : history.length ? (
            <p className="caption mr-auto">No active runs</p>
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  )
}
