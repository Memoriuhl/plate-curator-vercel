'use client'

import {
  useEffect,
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
import { TooltipProvider } from '@/components/ui/tooltip'
import { compareQueueOrder } from '@/lib/jobs/queue-order'
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
  updatedAt?: number
  progress?: { endedAt?: number }
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

export type RunDisclosure = { expanded: boolean; onToggle: () => void }

export function PipelineRunRail<T extends RailRun>({
  runs,
  renderRun,
  stacked,
  requestedRunId,
}: {
  runs: T[]
  stacked?: boolean
  requestedRunId?: string
  renderRun: (run: T, disclosure?: RunDisclosure) => ReactNode
}) {
  const [expansion, setExpansion] = useState<{
    request?: string
    open: ReadonlySet<string>
    running: ReadonlyMap<string, number>
  }>()
  const rail = runs
    .filter((run) => run.dismissedAt === undefined)
    .sort(compareQueueOrder)
  const viewport = useRef<HTMLDivElement>(null)
  const newestId = rail.at(-1)?.id
  const running = stacked ? rail.filter((run) => run.status === 'running') : []
  const groups = stacked
    ? [
        { title: 'Running', runs: running },
        { title: 'Queue', runs: rail.filter((run) => run.status === 'queued') },
        {
          title: 'Recent runs',
          runs: rail
            .filter(
              (run) => run.status !== 'running' && run.status !== 'queued'
            )
            .sort(
              (a, b) =>
                (b.progress?.endedAt ?? b.updatedAt ?? b.createdAt) -
                  (a.progress?.endedAt ?? a.updatedAt ?? a.createdAt) ||
                compareQueueOrder(b, a)
            ),
        },
      ]
    : [{ title: undefined, runs: rail }]
  useLayoutEffect(() => {
    const element = viewport.current
    if (!stacked && element) element.scrollLeft = element.scrollWidth
  }, [newestId, stacked])
  useLayoutEffect(() => {
    const drawer = viewport.current?.closest('[data-pipeline-scroll]')
    if (stacked && drawer && requestedRunId) drawer.scrollTop = 0
  }, [requestedRunId, stacked])
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
      const scroller =
        stacked && event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-pipeline-flow]')
          : element
      if (!scroller) return
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? scroller.clientWidth
            : 1
      const previous = scroller.scrollLeft
      scroller.scrollLeft += event.deltaY * unit
      if (scroller.scrollLeft !== previous) event.preventDefault()
    }
    element.addEventListener('wheel', scrollRail, { passive: false })
    return () => element.removeEventListener('wheel', scrollRail)
  }, [stacked])
  const initialRunId =
    requestedRunId ?? groups.find((group) => group.runs.length)?.runs[0]?.id
  const requestedOpen =
    !expansion || (requestedRunId && expansion.request !== requestedRunId)
      ? initialRunId
      : undefined
  const runningAttempts = new Map(
    running.map((run) => [
      run.id,
      run.enqueueSequence ?? run.queuedAt ?? run.createdAt,
    ])
  )
  const started = [...runningAttempts].filter(
    ([id, sequence]) => expansion?.running.get(id) !== sequence
  )
  if (
    stacked &&
    (requestedOpen ||
      started.length ||
      (expansion && expansion.running.size !== runningAttempts.size))
  ) {
    const open = new Set(expansion?.open)
    if (requestedOpen) open.add(requestedOpen)
    for (const [id] of started) open.add(id)
    setExpansion({ request: requestedRunId, running: runningAttempts, open })
  }

  function toggleRun(runId: string) {
    setExpansion((current) => {
      if (!current) return current
      const open = new Set(current.open)
      if (!open.delete(runId)) open.add(runId)
      return { ...current, open }
    })
  }
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
      <div
        ref={viewport}
        className={styles.rail}
        role="region"
        aria-label={
          stacked
            ? 'Plate Pipeline runs'
            : 'Plate Pipeline runs, scroll horizontally'
        }
        tabIndex={stacked ? undefined : 0}
      >
        {rail.length ? (
          <ol className={styles.runList} data-stacked={stacked || undefined}>
            {groups.flatMap(({ title, runs }) => [
              ...(title && runs.length
                ? [
                    <li
                      key={`section-${title}`}
                      role="presentation"
                      className={styles.runSection}
                    >
                      <h3>{title}</h3>
                    </li>,
                  ]
                : []),
              ...runs.map((run) => (
                <li key={run.id}>
                  {renderRun(
                    run,
                    stacked
                      ? {
                          expanded: expansion?.open.has(run.id) ?? false,
                          onToggle: () => toggleRun(run.id),
                        }
                      : undefined
                  )}
                </li>
              )),
            ])}
          </ol>
        ) : runs.length ? (
          <p className="caption">No active runs</p>
        ) : null}
      </div>
    </TooltipProvider>
  )
}
