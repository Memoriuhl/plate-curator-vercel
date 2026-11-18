'use client'

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import Link from 'next/link'
import { IoTimeOutline } from 'react-icons/io5'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { tabsListVariants } from '@/components/ui/tabs'
import { Toggle } from '@/components/ui/toggle'
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

export function PipelineRailSkeleton() {
  return (
    <div
      className={styles.railSkeleton}
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
          <span />
        </div>
      ))}
    </div>
  )
}

/** List finished runs separately from the active dashboard rail. */
export function PipelineRunHistory<T extends RailRun>({
  runs,
  includeFinished,
  progress,
  renderHistory,
  historyHref,
}: {
  runs: T[]
  includeFinished?: boolean
  progress: (run: T) => PipelineProgress
  renderHistory: (run: T) => ReactNode
  historyHref: (run: T) => string
}) {
  const history = runs
    .filter(
      (run) =>
        (includeFinished || run.dismissedAt !== undefined) &&
        ['completed', 'failed', 'cancelled'].includes(run.status)
    )
    .sort(
      (a, b) =>
        (progress(b).endedAt ?? b.createdAt) -
        (progress(a).endedAt ?? a.createdAt)
    )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className={styles.history}>
          <IoTimeOutline aria-hidden="true" />
          History
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
                          end === undefined ? undefined : end - run.createdAt
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
  )
}

/** Keep undismissed cards in enqueue order and scroll to newly added runs. */
export function PipelineRunRail<T extends RailRun>({
  runs,
  progress,
  renderHeader,
  renderRun,
  children,
}: {
  runs: T[]
  progress: (run: T) => PipelineProgress
  renderHeader: (display: ReactNode) => ReactNode
  renderRun: (
    run: T,
    progress: PipelineProgress,
    stepsOpen: boolean
  ) => ReactNode
  children?: ReactNode
}) {
  const rail = runs
    .filter((run) => run.dismissedAt === undefined)
    .sort(
      (a, b) =>
        (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt) ||
        (a.enqueueSequence ?? 0) - (b.enqueueSequence ?? 0) ||
        a.id.localeCompare(b.id)
    )
    .map((run) => ({ run, progress: progress(run) }))
  const hasPlateSteps = rail.some((item) =>
    item.progress.steps.some((step) => step.stage !== 'group')
  )
  const [stepsOpen, setStepsOpen] = useState(false)
  const railId = useId()
  const viewport = useRef<HTMLDivElement>(null)
  const newestId = rail.at(-1)?.run.id
  useLayoutEffect(() => {
    const element = viewport.current
    if (element) element.scrollLeft = element.scrollWidth
  }, [newestId])
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const scrollRail = (event: WheelEvent) => {
      if (
        !event.cancelable ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.shiftKey ||
        Math.abs(event.deltaX) >= Math.abs(event.deltaY) ||
        (event.target instanceof Element &&
          event.target.closest('[data-pipeline-watch-steps]'))
      )
        return
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? element.clientWidth
            : 1
      const previous = element.scrollLeft
      element.scrollLeft += event.deltaY * unit
      if (element.scrollLeft !== previous) event.preventDefault()
    }
    element.addEventListener('wheel', scrollRail, { passive: false })
    return () => element.removeEventListener('wheel', scrollRail)
  }, [])
  const summary = (
    ['failed', 'queued', 'running', 'completed', 'cancelled'] as const
  )
    .flatMap((status) => {
      const count = rail.filter(({ run }) => run.status === status).length
      return count ? [`${count} ${historyLabels[status].toLowerCase()}`] : []
    })
    .join(', ')
  const display = hasPlateSteps && (
    <div
      role="group"
      aria-label="Pipeline display"
      className={tabsListVariants({ className: styles.display })}
    >
      <Toggle
        type="button"
        variant="inset"
        pressed={!stepsOpen}
        aria-controls={railId}
        onPressedChange={() => setStepsOpen(false)}
      >
        Runs
      </Toggle>
      <Toggle
        type="button"
        variant="inset"
        pressed={stepsOpen}
        aria-controls={railId}
        onPressedChange={() => setStepsOpen(true)}
      >
        Plate steps
      </Toggle>
    </div>
  )
  return (
    <TooltipProvider delayDuration={250}>
      {renderHeader(display)}
      {children}
      <p className="sr-only" role="status">
        {summary ? `Plate Pipeline: ${summary}` : ''}
      </p>
      <div
        ref={viewport}
        id={railId}
        className={styles.rail}
        role="region"
        aria-label="Plate Pipeline runs, scroll horizontally"
        tabIndex={0}
      >
        {rail.length ? (
          <ol className={styles.runList}>
            {rail.map(({ run, progress }) => (
              <li key={run.id}>{renderRun(run, progress, stepsOpen)}</li>
            ))}
          </ol>
        ) : runs.length ? (
          <p className="caption">No active runs</p>
        ) : null}
      </div>
    </TooltipProvider>
  )
}
