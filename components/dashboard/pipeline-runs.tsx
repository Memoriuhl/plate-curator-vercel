'use client'


import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react'
import useSWR from 'swr'
import { Dialog } from 'radix-ui'
import {
  IoChevronDown,
  IoClose,
  IoDesktopOutline,
  IoLayersOutline,
} from 'react-icons/io5'
import { FaPersonDigging } from 'react-icons/fa6'
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
import { useMe, useSharedDraftId } from '@/lib/client/hooks'
import { useSearchParams } from 'next/navigation'
import type { GatewayRun } from '@/lib/jobs/gateway-runs'
import type { LocalRunStage } from '@/lib/jobs/queue-types'
import { gatewayRunsKey, usePipelineQueue } from './use-pipeline-queue'
import { disabledRunStages } from './pipeline-stages'
import {
  PipelineQueuePanel,
  type OpenStageResults,
} from './pipeline-queue-panel'
import { PipelineDrawerRunResults } from './pipeline-run-results'
import {
  machineLabels,
  queueRunExecution,
  type PipelineMachineFilter,
} from './pipeline-run-execution'
import styles from './pipeline-runs.module.css'

const devices = [
  { id: 'all', Icon: IoLayersOutline },
  { id: 'local', Icon: IoDesktopOutline },
  { id: 'gateway', Icon: SiVercel },
] as const
type Queue = ReturnType<typeof usePipelineQueue>
const DashboardPipelineContext = createContext<{
  queue: Queue
  openPipeline: (runId?: string) => void
  requestedRun?: { id: string }
  open: boolean
  setOpen: Dispatch<SetStateAction<boolean>>
  device: PipelineMachineFilter
  setDevice: (device: PipelineMachineFilter) => void
  drawerId: string
  launcher: RefObject<HTMLButtonElement | null>
} | null>(null)

export function DashboardPipelineProvider({
  children,
}: {
  children: ReactNode
}) {
  const local = process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1'
  // Runs write into the shared draft. `?pipeline=open` (linked from the Publish view
  // while runs block Publish) opens the drawer on arrival.
  const draftId = useSharedDraftId()
  const params = useSearchParams()
  const queue = usePipelineQueue(local ? draftId : null, 'Shared draft')
  const [open, setOpen] = useState(() => params?.get('pipeline') === 'open')
  const [device, setDevice] = useState<PipelineMachineFilter>('all')
  const [requestedRun, setRequestedRun] = useState<{ id: string }>()
  const drawerId = useId()
  const launcher = useRef<HTMLButtonElement>(null)
  function openPipeline(runId?: string) {
    if (runId) setRequestedRun({ id: runId })
    setDevice('all')
    setOpen(true)
  }
  async function enqueue(...args: Parameters<Queue['enqueue']>) {
    // Stages marked work in progress never start, whichever control asked.
    if (disabledRunStages(args[1]).length) return null
    const run = await queue.enqueue(...args)
    if (run) openPipeline(run.id)
    return run
  }
  return (
    <DashboardPipelineContext.Provider
      value={{
        queue: { ...queue, enqueue },
        openPipeline,
        requestedRun,
        open,
        setOpen,
        device,
        setDevice,
        drawerId,
        launcher,
      }}
    >
      {children}
    </DashboardPipelineContext.Provider>
  )
}

export function useDashboardPipeline() {
  const dashboard = useContext(DashboardPipelineContext)
  if (!dashboard)
    throw new Error('Dashboard pipeline requires DashboardPipelineProvider')
  return dashboard
}

function PipelineRoadSign() {
  return (
    <span className={styles.pipelineSign} aria-hidden="true">
      <FaPersonDigging />
    </span>
  )
}

export function DashboardPipelineToggle() {
  const { open, setOpen, drawerId, launcher } = useDashboardPipeline()
  return (
    <Button
      ref={launcher}
      type="button"
      variant="outline"
      className={styles.drawerLauncher}
      aria-label="Open Plate Pipeline"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={drawerId}
      aria-keyshortcuts="Meta+B Control+B"
      onClick={() => setOpen(true)}
    >
      <PipelineRoadSign />
      <span>Plate Pipeline</span>
      <kbd aria-hidden="true">⌘B</kbd>
    </Button>
  )
}

export function DashboardPipelineDrawer() {
  const { open, setOpen } = useDashboardPipeline()
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.altKey ||
        event.shiftKey ||
        (!event.metaKey && !event.ctrlKey) ||
        event.key.toLowerCase() !== 'b'
      )
        return
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'
        )
      )
        return
      event.preventDefault()
      setOpen((current) => !current)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [setOpen])
  return (
    <Dialog.Root open={open} onOpenChange={setOpen} modal={false}>
      <Dialog.Portal>{open && <PipelineDrawerPages />}</Dialog.Portal>
    </Dialog.Root>
  )
}

function PipelineDrawerPages() {
  const { queue, device, setDevice, drawerId, launcher, requestedRun } =
    useDashboardPipeline()
  const [results, setResults] = useState<{
    runId: string
    stage: LocalRunStage
    open: boolean
    request: typeof requestedRun
  }>()
  const showingResults =
    results?.open === true && results.request === requestedRun
  const closeButton = useRef<HTMLButtonElement>(null)
  const backButton = useRef<HTMLButtonElement>(null)
  const resultPage = useRef<HTMLDivElement>(null)
  const eye = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    if (showingResults) {
      if (resultPage.current) resultPage.current.scrollTop = 0
      backButton.current?.focus({ preventScroll: true })
    } else if (eye.current) {
      const target = eye.current.isConnected ? eye.current : closeButton.current
      target?.focus({ preventScroll: true })
      eye.current = null
    }
  }, [showingResults])

  function showStageResults(
    runId: string,
    stage: LocalRunStage,
    trigger: HTMLButtonElement
  ) {
    eye.current = trigger
    setResults({ runId, stage, open: true, request: requestedRun })
  }

  function backToRuns() {
    setResults((current) => current && { ...current, open: false })
  }

  return (
    <Dialog.Content
      id={drawerId}
      data-pipeline-drawer
      className={styles.drawer}
      aria-describedby={undefined}
      onInteractOutside={(event) => event.preventDefault()}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        closeButton.current?.focus({ preventScroll: true })
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        launcher.current?.focus({ preventScroll: true })
      }}
      onEscapeKeyDown={(event) => {
        if (showingResults) {
          event.preventDefault()
          backToRuns()
        }
      }}
    >
      <Dialog.Title asChild>
        <span className="sr-only">Plate Pipeline</span>
      </Dialog.Title>
      <Dialog.Close asChild>
        <Button
          ref={closeButton}
          type="button"
          size="icon"
          variant="ghost"
          className={styles.drawerClose}
          aria-label="Close Plate Pipeline"
        >
          <IoClose aria-hidden="true" />
        </Button>
      </Dialog.Close>
      <div
        className={styles.drawerPages}
        data-results={showingResults || undefined}
      >
        <div
          data-pipeline-scroll
          className={styles.drawerPage}
          inert={showingResults}
          aria-hidden={showingResults || undefined}
        >
          <PipelineRuns
            queue={queue}
            stacked
            activeDevice={device}
            onDeviceChange={setDevice}
            requestedRunId={requestedRun?.id}
            title={
              <h2 className={`page-title ${styles.pipelineTitle}`}>
                <PipelineRoadSign />
                Plate Pipeline
              </h2>
            }
            onOpenStageResults={showStageResults}
          />
        </div>
        <div
          ref={resultPage}
          className={styles.drawerPage}
          inert={!showingResults}
          aria-hidden={!showingResults || undefined}
        >
          {results && (
            <PipelineDrawerRunResults
              key={`${results.runId}:${results.stage}`}
              runId={results.runId}
              stage={results.stage}
              active={showingResults}
              backRef={backButton}
              onBack={backToRuns}
            />
          )}
        </div>
      </div>
    </Dialog.Content>
  )
}

/**
 * Combine hosted and local run views for the dashboard, including their selected detail
 * panels.
 */
export function PipelineRuns({
  queue,
  stacked,
  activeDevice,
  onDeviceChange,
  title,
  requestedRunId,
  onOpenStageResults,
}: {
  queue: Queue
  stacked?: boolean
  activeDevice?: PipelineMachineFilter
  onDeviceChange?: (device: PipelineMachineFilter) => void
  title?: ReactNode
  requestedRunId?: string
  onOpenStageResults?: OpenStageResults
}) {
  const local = process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1'
  const [internalView, setInternalView] = useState<PipelineMachineFilter>('all')
  const view = activeDevice ?? internalView
  const setView = onDeviceChange ?? setInternalView
  const { user, api, ready } = useSession()
  const me = useMe()
  // Reuse the Gateway list and poll less often while checking for runs on the other device.
  const gateway = useSWR<{ runs: GatewayRun[]; observedAt: number }>(
    user ? gatewayRunsKey : null,
    api.get,
    { refreshInterval: view === 'local' ? 30000 : 3000 }
  )
  const gatewayRuns = gateway.data?.runs ?? []
  const gatewayPending = ready === false || (gateway.isLoading && !gateway.data)
  const device = devices.find((device) => device.id === view) ?? devices[0]
  const queueMachines = new Set(
    local
      ? queue.runs.flatMap((run) =>
          queueRunExecution(run).map(({ machine }) => machine)
        )
      : []
  )
  const available = {
    all: true,
    local: queueMachines.has('local'),
    gateway: queueMachines.has('gateway') || gatewayRuns.length > 0,
  }
  function header(history: ReactNode) {
    return (
      <header className={styles.header}>
        <div className={styles.heading}>
          {title ?? (
            <h2 className={`page-title ${styles.pipelineTitle}`}>
              <PipelineRoadSign />
              Plate Pipeline
            </h2>
          )}
          {history}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={styles.device}
              aria-label={`View runs: ${machineLabels[view]}`}
            >
              <device.Icon aria-hidden="true" />
              <span>{machineLabels[view]}</span>
              <IoChevronDown aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className={styles.deviceMenu}
            collisionPadding={12}
            aria-label="View runs"
          >
            <DropdownMenuRadioGroup
              value={view}
              onValueChange={(value) => setView(value as PipelineMachineFilter)}
            >
              {devices.map(({ id, Icon }) => (
                <DropdownMenuRadioItem
                  key={id}
                  value={id}
                  className={styles.deviceOption}
                  disabled={!available[id]}
                >
                  <Icon aria-hidden="true" />
                  <span>{machineLabels[id]}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
    )
  }
  /** Display the signed-in curator's name when they requested the run. */
  const requester = (uid: string) =>
    uid === me.data?.uid ? (me.data.name ?? 'You') : undefined
  return (
    <section className={styles.panel} aria-label="Plate Pipeline">
      <PipelineQueuePanel
        requester={requester}
        queue={queue}
        header={header}
        stacked={stacked}
        requestedRunId={requestedRunId}
        onOpenStageResults={onOpenStageResults}
        machineFilter={view}
        localEnabled={local}
        gateway={
          view === 'local'
            ? undefined
            : {
                runs: gatewayRuns,
                observedAt: gateway.data?.observedAt,
                loading: gatewayPending,
                error: gateway.error,
                refresh: gateway.mutate,
              }
        }
      />
    </section>
  )
}
