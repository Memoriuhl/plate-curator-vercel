'use client'

import { reviewHref } from '@/lib/review/href'
import { mostRecentBatch } from '@/lib/review/batch-selection'

import { createContext, useContext, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { IoChevronDown, IoDesktopOutline } from 'react-icons/io5'
import { SiVercel } from 'react-icons/si'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useSession } from '@/lib/client/session'
import { useBatches, useMe } from '@/lib/client/hooks'
import type { GatewayRun } from '@/lib/jobs/gateway-runs'
import { taggingModel } from '@/lib/tagging/models'
import { gatewayRunsKey, usePipelineQueue } from './use-pipeline-queue'
import { PipelineQueuePanel } from './pipeline-queue-panel'
import { PipelineRunCard } from './pipeline-run-card'
import {
  PipelineRailSkeleton,
  PipelineRunHistory,
  PipelineRunRail,
} from './pipeline-run-rail'
import { PipelinePlateList } from './pipeline-run-plates'
import styles from './pipeline-runs.module.css'

const devices = [
  { id: 'local', label: 'Local PC', Icon: IoDesktopOutline },
  { id: 'gateway', label: 'Vercel Gateway', Icon: SiVercel },
] as const

const DashboardPipelineContext = createContext<ReturnType<
  typeof usePipelineQueue
> | null>(null)

export function DashboardPipelineProvider({
  children,
}: {
  children: ReactNode
}) {
  const batches = useBatches(['open'], {
    mine: true,
    enabled: process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1',
  })
  const batch = mostRecentBatch(batches.data)
  const queue = usePipelineQueue(batch?.id, batch?.name)
  return (
    <DashboardPipelineContext.Provider value={queue}>
      {children}
    </DashboardPipelineContext.Provider>
  )
}

export function useDashboardPipeline() {
  const queue = useContext(DashboardPipelineContext)
  if (!queue)
    throw new Error('Dashboard pipeline requires DashboardPipelineProvider')
  return queue
}

export function DashboardPipelineRail() {
  const queue = useDashboardPipeline()
  return (
    <div className="states-pipeline">
      <PipelineRuns queue={queue} />
    </div>
  )
}

/**
 * Combine hosted and local run views for the dashboard, including their selected detail
 * panels.
 */
export function PipelineRuns({
  queue,
}: {
  queue: ReturnType<typeof usePipelineQueue>
}) {
  const local = process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1'
  const [view, setView] = useState(local ? 'local' : 'gateway')
  const { user, api, ready } = useSession()
  const me = useMe()
  // Reuse the Gateway list and poll less often while checking for runs on the other device.
  const gateway = useSWR<{ runs: GatewayRun[]; observedAt: number }>(
    user ? gatewayRunsKey : null,
    api.get,
    { refreshInterval: view === 'gateway' ? 3000 : 30000 }
  )
  const gatewayRuns = gateway.data?.runs ?? []
  const gatewayPending = ready === false || (gateway.isLoading && !gateway.data)
  const device = view === 'local' ? devices[0] : devices[1]
  const canSwitch =
    local && (view === 'local' ? gatewayRuns.length > 0 : queue.runs.length > 0)
  function header(history: ReactNode) {
    return (
      <header className={styles.header}>
        <div className={styles.heading}>
          <h2 className="page-title">Plate Pipeline</h2>
          {history}
        </div>
        {canSwitch ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={styles.device}
                aria-label={`View runs: ${device.label}`}
              >
                <device.Icon aria-hidden="true" />
                <span>{device.label}</span>
                <IoChevronDown aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className={styles.deviceMenu}
              collisionPadding={12}
              aria-label="View runs"
            >
              <DropdownMenuRadioGroup value={view} onValueChange={setView}>
                {devices.map(({ id, label, Icon }) => (
                  <DropdownMenuRadioItem
                    key={id}
                    value={id}
                    className={styles.deviceOption}
                  >
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span className={styles.deviceLabel}>
            <device.Icon aria-hidden="true" />
            {device.label}
          </span>
        )}
      </header>
    )
  }
  /** Display the signed-in curator's name when they requested the run. */
  const requester = (uid: string) =>
    uid === me.data?.uid ? (me.data.name ?? 'You') : undefined
  const history = gatewayPending ? null : (
    <PipelineRunHistory
      runs={gatewayRuns}
      includeFinished
      progress={(run) => run.progress}
      historyHref={(run) =>
        reviewHref(undefined, undefined, run.batchId, { run: run.id })
      }
      renderHistory={(run) => (
        <>
          <p className="caption">
            {taggingModel(run.modelId)?.label ?? run.modelId}
          </p>
          <PipelinePlateList
            plateIds={run.plateIds}
            steps={run.progress.steps}
            plates={run.plates}
          />
          {run.results.length ? (
            <ul className={styles.stepList}>
              {run.results.map((result) => (
                <li key={result.jobId}>
                  <strong>{result.plateName}</strong>
                  <span>
                    Suggested tags: {result.suggestions.join(', ') || 'None'}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    />
  )
  return (
    <section className={styles.panel} aria-label="Plate Pipeline">
      {view === 'local' ? (
        <PipelineQueuePanel
          requester={requester}
          queue={queue}
          header={header}
        />
      ) : (
        <>
          {header(history)}
          {gatewayPending ? (
            <PipelineRailSkeleton />
          ) : (
            <>
              {gateway.error ? (
                <p role="alert">
                  Could not load gateway runs.{' '}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void gateway.mutate()}
                  >
                    Refresh runs
                  </Button>
                </p>
              ) : !gatewayRuns.length ? (
                <p className="caption">No gateway runs yet.</p>
              ) : null}
              <PipelineRunRail
                runs={gatewayRuns}
                renderRun={(run) => (
                  <PipelineRunCard
                    run={run}
                    progress={run.progress}
                    stages={run.stages ?? ['tag']}
                    observedAt={gateway.data?.observedAt}
                    requester={requester(run.requestedBy)}
                    plates={run.plates}
                    device="Vercel Gateway"
                  />
                )}
              />
            </>
          )}
        </>
      )}
    </section>
  )
}
