import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SWRConfig } from 'swr'
import { IoAddCircleOutline, IoPencilOutline } from 'react-icons/io5'
import { TooltipProvider } from '../../components/ui/tooltip'
import { useEffect, type ReactNode } from 'react'
import {
  pipelineRunDetailKey,
  PipelineQueueWarmup,
  usePipelineQueue,
} from '../../components/dashboard/pipeline-runs/use-pipeline-queue'
import { PipelineQueuePanel } from '../../components/dashboard/pipeline-runs/pipeline-queue-panel'
import {
  PipelineRunResults,
  PipelineRunResultsPage,
} from '../../components/dashboard/pipeline-runs/pipeline-run-results'
import type { QueueRunView } from '../../lib/jobs/queue/queue-types'
import { PipelineRunControls } from '../../components/dashboard/pipeline-runs/pipeline-run-controls'
import { RunMenu } from '../../components/dashboard/pipeline-runs/run-menu'
import { SelectionBar } from '../../components/dashboard/selection/selection-bar'
import { runTimingKey } from '../../lib/jobs/run-timings'
import { PipelineOptionSelect } from '../../components/dashboard/pipeline-runs/pipeline-option-select'
import { TAGGING_MODELS } from '../../lib/tagging/models'
import {
  PipelineFieldValue,
  pipelineFieldLabel,
} from '../../components/dashboard/pipeline-runs/pipeline-field-value'
import { imageGroupCapabilities } from '../../lib/jobs/image-options'
import { PlateEnhancementPreview } from '../../components/plate/plate-image-preview'
import { PlatePipelineTimeline } from '../../components/dashboard/pipeline-runs/plate-pipeline-timeline'
import { PipelineRunCard } from '../../components/dashboard/pipeline-runs/pipeline-run-card'
import {
  DashboardPipelineDrawer,
  DashboardPipelineProvider,
  DashboardPipelineToggle,
  PipelineRuns,
  useDashboardPipeline,
} from '../../components/dashboard/pipeline-runs/pipeline-runs'
import { queueProgress } from '../../lib/jobs/run-progress'
import {
  plateSelection,
  SelectionPresence,
} from '../../components/dashboard/selection/plate-selection'
import { plateCards } from '../../fixtures/plate-cards'
import type { PlateCardData } from '../../lib/catalog/dashboard-types'
import { RESEARCH_MODELS } from '../../lib/research/models/models'

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), send: vi.fn() },
  revertRun: vi.fn(),
  /** The live refresh each mounted view registered, by its request key. */
  refreshers: new Map<string, () => unknown>(),
  /** The safety refresh each view last asked for, by its request key. */
  safety: new Map<string, number | undefined>(),
  ensure: vi.fn(),
  pathname: '/states/AK',
  modelId: 'desktop-gemma4-12b',
  models: [] as (typeof TAGGING_MODELS)[number][],
  workspace: { mode: 'personal' } as {
    mode: string
    id?: string
    status?: string
    detail?: { batch: { state: string } }
  },
}))
vi.mock('../../lib/client/session', () => ({
  useSession: () => ({ user: { uid: 'editor' }, api: mocks.api }),
}))
vi.mock('../../lib/client/hooks', () => ({
  useTaggingModels: () => ({
    data: { models: mocks.models, default: mocks.modelId },
  }),
  useEnsureBatch: () => mocks.ensure,
  useWorkspaceBatch: () => mocks.workspace,
  useSelectedBatchId: () => null,
  useBatches: () => ({ data: [] }),
  useMe: () => ({ data: { uid: 'editor', name: 'Editor' } }),
  useSharedDraftId: () => 'shared-draft-test',
  useReviewActions: () => ({ revertPipelineRun: mocks.revertRun }),
}))

// Change-signal refresh has its own tests; here it stays connected and quiet, and a
// test can run a round by calling the views' refreshes.
vi.mock('../../lib/client/live-signal', async (importOriginal) => {
  const { useEffect, useRef } = await import('react')
  return {
    ...(await importOriginal<typeof import('../../lib/client/live-signal')>()),
    useLiveRefresh: (
      _topics: unknown,
      refresh: () => unknown,
      options: { key?: string; enabled?: boolean } = {}
    ) => {
      const latest = useRef(refresh)
      latest.current = refresh
      const { key, enabled = true } = options as typeof options & {
        safetyMs?: number
      }
      if (key && enabled)
        mocks.safety.set(key, (options as { safetyMs?: number }).safetyMs)
      useEffect(() => {
        if (!key || !enabled) return
        const run = () => latest.current()
        mocks.refreshers.set(key, run)
        return () => {
          if (mocks.refreshers.get(key) === run) mocks.refreshers.delete(key)
        }
      }, [key, enabled])
      return 'live'
    },
  }
})

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => mocks.pathname,
  useRouter: () => ({ prefetch: vi.fn() }),
}))

const resultActions = {
  action: null,
  apply: vi.fn(),
  chooseImage: vi.fn(),
  recover: vi.fn(),
}

/**
 * Build a saved queue run with a default attempt and optional scenario-specific
 * overrides.
 */
function saved(overrides: Partial<QueueRunView> = {}): QueueRunView {
  return {
    id: 'saved-run',
    requestId: 'request',
    fingerprint: 'input',
    batchId: 'batch',
    requestedBy: 'editor',
    env: 'preview:local-pipeline-test',
    localScope: 'test',
    plateIds: ['AK.one'],
    stages: ['tag'],
    options: {},
    previewOnly: true,
    createdAt: 100,
    queuedAt: 100,
    enqueueSequence: 1,
    updatedAt: 100,
    status: 'queued',
    resourceClass: 'gpu',
    jobs: [],
    editable: true,
    applied: false,
    attempts: [
      {
        number: 1,
        requestId: 'request',
        createdAt: 100,
        status: 'queued',
        cursor: 0,
        jobIds: [],
        completedJobIds: [],
        choices: {},
        steps: [
          { index: 0, plateId: 'AK.one', stage: 'tag', resourceClass: 'gpu' },
        ],
      },
    ],
    ...overrides,
  }
}
const plate: PlateCardData = {
  ...plateCards[0],
  id: 'AK.one',
  state: 'AK',
  displayName: 'One',
  revision: 'hash',
  tags: [],
  imageUrl: null,
  checks: {
    ...plateCards[0].checks,
    description: { value: null, status: 'missing' },
  },
}
/** Render the hook under an isolated SWR cache with request retries disabled. */
const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig
    value={{
      provider: () => new Map(),
      dedupingInterval: 0,
      shouldRetryOnError: false,
    }}
  >
    {children}
  </SWRConfig>
)
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  localStorage.clear()
  mocks.workspace = { mode: 'personal' }
  mocks.pathname = '/states/AK'
  mocks.ensure.mockReset().mockResolvedValue('batch')
  plateSelection.replace([plate])
  mocks.models = [...TAGGING_MODELS]
  mocks.modelId = 'desktop-gemma4-12b'
  mocks.api.get
    .mockReset()
    .mockResolvedValue({ runs: [saved()], selected: saved() })
  mocks.api.send.mockReset().mockResolvedValue({ run: saved() })
  mocks.refreshers.clear()
  mocks.safety.clear()
})
afterEach(() => {
  cleanup()
  plateSelection.clear()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

test('reload restores saved run via one list, and an active run does not block enqueue', async () => {
  const first = renderHook(usePipelineQueue, { wrapper })
  await waitFor(() =>
    expect(first.result.current.runs[0]?.id).toBe('saved-run')
  )
  expect(
    mocks.api.get.mock.calls.every((args) =>
      args[0].startsWith('/api/local-pipeline/runs')
    )
  ).toBe(true)
  await act(async () => {
    await first.result.current.enqueue([plate], ['tag'])
  })
  expect(mocks.api.send).toHaveBeenCalledWith(
    'POST',
    '/api/local-pipeline/runs/selection',
    expect.objectContaining({
      batchName: 'AK pipeline',
      plateIds: ['AK.one'],
      stages: ['tag'],
      requestId: expect.any(String),
    })
  )
  first.unmount()
  const restored = renderHook(usePipelineQueue, { wrapper })
  act(() => restored.result.current.select('saved-run'))
  await waitFor(() =>
    expect(restored.result.current.selected?.id).toBe('saved-run')
  )
})

test('Start Run opens the drawer with the newly accepted run expanded', async () => {
  const older = saved({ id: 'older', createdAt: 50, queuedAt: 50 })
  const latest = saved({ id: 'latest', createdAt: 200, queuedAt: 200 })
  let started = false
  mocks.api.get.mockImplementation(async (path: string) =>
    path.startsWith('/api/local-pipeline')
      ? { runs: started ? [older, latest] : [older] }
      : { runs: [] }
  )
  mocks.api.send.mockImplementation(async () => {
    started = true
    return { run: latest }
  })
  function Dashboard() {
    const { queue } = useDashboardPipeline()
    return (
      <>
        <PipelineRunControls
          batchPlates={[plate]}
          stateName="Alaska"
          queue={queue}
        />
        <DashboardPipelineDrawer />
      </>
    )
  }
  render(
    <DashboardPipelineProvider>
      <Dashboard />
    </DashboardPipelineProvider>,
    { wrapper }
  )
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  const form = screen.getByRole('dialog', { name: 'Run pipeline' })
  expect(screen.queryByRole('dialog', { name: 'Plate Pipeline' })).toBeNull()
  fireEvent.click(within(form).getByRole('checkbox', { name: 'Tag' }))
  fireEvent.click(within(form).getByRole('button', { name: 'Start Run' }))
  const drawer = await screen.findByRole('dialog', { name: 'Plate Pipeline' })
  expect(
    within(drawer).getByRole('button', { name: 'View runs: All Machines' })
  ).toBeTruthy()
  expect(
    within(drawer)
      .getAllByRole('article')
      .map((article) => article.getAttribute('aria-label'))
  ).toEqual(['Pipeline run older', 'Pipeline run latest'])
  const newest = within(drawer).getByRole('button', { name: /latest/ })
  const previous = within(drawer).getByRole('button', { name: /older/ })
  expect(newest.getAttribute('aria-expanded')).toBe('true')
  expect(previous.getAttribute('aria-expanded')).toBe('false')
  expect(
    within(drawer).queryByRole('region', { name: 'Pipeline steps by plate' })
  ).toBeNull()
  fireEvent.click(within(drawer).getByRole('button', { name: 'View plates' }))
  expect(
    within(drawer).getByRole('region', { name: 'Pipeline steps by plate' })
  ).toBeTruthy()
  fireEvent.click(previous)
  expect(newest.getAttribute('aria-expanded')).toBe('true')
  expect(previous.getAttribute('aria-expanded')).toBe('true')
  expect(
    within(drawer).getByRole('region', { name: 'Pipeline steps by plate' })
  ).toBeTruthy()
  fireEvent.click(newest)
  expect(newest.getAttribute('aria-expanded')).toBe('false')
  expect(previous.getAttribute('aria-expanded')).toBe('true')
  expect(
    within(drawer).queryByRole('region', { name: 'Pipeline steps by plate' })
  ).toBeNull()
})

test('the warmup shares its request and cached cards with the dashboard', async () => {
  let finish!: (data: { runs: QueueRunView[] }) => void
  mocks.api.get.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  function Dashboard() {
    const queue = usePipelineQueue()
    return <PipelineQueuePanel queue={queue} />
  }
  const Layout = ({ view }: { view: 'none' | 'dashboard' }) => (
    <>
      <PipelineQueueWarmup />
      {view === 'dashboard' && <Dashboard />}
    </>
  )
  const page = render(<Layout view="none" />, { wrapper })
  await waitFor(() =>
    expect(mocks.api.get).toHaveBeenCalledExactlyOnceWith(
      '/api/local-pipeline/runs?detail=none'
    )
  )
  page.rerender(<Layout view="dashboard" />)
  expect(
    screen.getByRole('status', { name: 'Loading pipeline runs' })
  ).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'History' })).toBeNull()
  expect(mocks.api.get).toHaveBeenCalledTimes(1)

  await act(async () => finish({ runs: [saved()] }))
  expect(
    screen.getByRole('article', { name: 'Pipeline run saved-run' })
  ).toBeTruthy()
  page.rerender(<Layout view="none" />)
  mocks.api.get.mockImplementation(() => new Promise(() => {}))
  page.rerender(<Layout view="dashboard" />)
  expect(
    screen.getByRole('article', { name: 'Pipeline run saved-run' })
  ).toBeTruthy()
  expect(
    screen.queryByRole('status', { name: 'Loading pipeline runs' })
  ).toBeNull()
})

test('returning from a run uses the newer queue snapshot loaded on the results page', async () => {
  const initial = saved()
  const updated = saved({ status: 'completed' })
  const unrelated = saved({ id: 'unrelated', status: 'running' })
  let summaryRequests = 0
  mocks.api.get.mockImplementation((path: string) => {
    if (path === pipelineRunDetailKey(updated.id))
      return Promise.resolve({
        runs: [updated],
        selected: updated,
        observedAt: 200,
      })
    return ++summaryRequests === 1
      ? Promise.resolve({ runs: [initial, unrelated], observedAt: 100 })
      : new Promise(() => {})
  })
  function QueueSnapshot({ detail }: { detail?: string }) {
    const queue = usePipelineQueue(undefined, undefined, detail)
    return (
      <div>
        {queue.runs.map((run) => (
          <span key={run.id}>{run.status}</span>
        ))}
      </div>
    )
  }
  const page = render(
    <>
      <PipelineQueueWarmup />
      <QueueSnapshot key="dashboard" />
    </>,
    { wrapper }
  )
  await screen.findByText('queued')
  page.rerender(
    <>
      <PipelineQueueWarmup />
      <QueueSnapshot key="detail" detail="saved-run" />
    </>
  )
  await screen.findByText('completed')
  page.rerender(
    <>
      <PipelineQueueWarmup />
      <QueueSnapshot key="dashboard" />
    </>
  )
  expect(screen.getByText('completed')).toBeTruthy()
  expect(screen.getByText('running')).toBeTruthy()
})

test.each([
  ['nothing', undefined],
  ['the same run', 'saved-run'],
])(
  'a live round refreshes the queue list with %s selected and an open run detail with one request',
  async (_name, selection) => {
    let status: QueueRunView['status'] = 'running'
    const run = () => saved({ status })
    mocks.api.get.mockImplementation(async (path: string) => {
      const detail = new URL(path, 'https://example.org').searchParams.get(
        'detail'
      )
      return {
        runs: [run()],
        observedAt: status === 'running' ? 100 : 200,
        ...(detail === 'saved-run' ? { selected: run() } : {}),
      }
    })
    function Views() {
      const list = usePipelineQueue()
      const detail = usePipelineQueue(undefined, undefined, 'saved-run')
      const { select } = list
      useEffect(() => {
        if (selection) select(selection)
      }, [select])
      return (
        <>
          <span>list {list.runs[0]?.status}</span>
          <span>detail {detail.selected?.status}</span>
        </>
      )
    }
    render(<Views />, { wrapper })
    await screen.findByText('list running')
    await screen.findByText('detail running')
    await waitFor(() => expect(mocks.refreshers.size).toBe(2))

    status = 'completed'
    mocks.api.get.mockClear()
    // A round calls every due view's refresh together.
    await act(async () => {
      for (const refresh of mocks.refreshers.values())
        void Promise.resolve().then(refresh)
    })
    await screen.findByText('list completed')
    await screen.findByText('detail completed')
    expect(mocks.api.get).toHaveBeenCalledExactlyOnceWith(
      '/api/local-pipeline/runs?detail=saved-run'
    )
  }
)

test('a round with a different selected run still refreshes each view', async () => {
  mocks.api.get.mockImplementation(async (path: string) => {
    const detail = new URL(path, 'https://example.org').searchParams.get(
      'detail'
    )
    const run = saved({ id: detail ?? 'saved-run' })
    return { runs: [run], selected: run }
  })
  function Views() {
    const list = usePipelineQueue()
    usePipelineQueue(undefined, undefined, 'saved-run')
    const { select } = list
    useEffect(() => select('other-run'), [select])
    return null
  }
  render(<Views />, { wrapper })
  await waitFor(() =>
    expect([...mocks.refreshers.keys()].sort()).toEqual([
      '/api/local-pipeline/runs?detail=other-run',
      pipelineRunDetailKey('saved-run'),
    ])
  )
  mocks.api.get.mockClear()
  await act(async () => {
    for (const refresh of mocks.refreshers.values())
      void Promise.resolve().then(refresh)
  })
  await waitFor(() => expect(mocks.api.get).toHaveBeenCalledTimes(2))
  expect(mocks.api.get.mock.calls.map(([path]) => path).sort()).toEqual([
    '/api/local-pipeline/runs?detail=other-run',
    pipelineRunDetailKey('saved-run'),
  ])
})

test.each([
  ['nothing', undefined],
  ['the same run', 'saved-run'],
])(
  'a late response from an earlier round never replaces a newer one, with %s selected and an open run detail',
  async (_name, selection) => {
    let status: QueueRunView['status'] = 'running'
    let holdNext = false
    const held: (() => void)[] = []
    mocks.api.get.mockImplementation(async (path: string) => {
      const detail = new URL(path, 'https://example.org').searchParams.get(
        'detail'
      )
      // The response reflects the state when the request was read.
      const body = {
        runs: [saved({ status })],
        observedAt: status === 'running' ? 100 : 200,
        ...(detail === 'saved-run' ? { selected: saved({ status }) } : {}),
      }
      if (!holdNext) return body
      holdNext = false
      return new Promise((resolve) => held.push(() => resolve(body)))
    })
    function Views() {
      const list = usePipelineQueue()
      const detail = usePipelineQueue(undefined, undefined, 'saved-run')
      const { select } = list
      useEffect(() => {
        if (selection) select(selection)
      }, [select])
      return (
        <>
          <span>list {list.runs[0]?.status}</span>
          <span>detail {detail.selected?.status}</span>
        </>
      )
    }
    render(<Views />, { wrapper })
    await screen.findByText('list running')
    await screen.findByText('detail running')
    await waitFor(() => expect(mocks.refreshers.size).toBe(2))
    // A round calls every due view's refresh together.
    const round = () =>
      act(async () => {
        for (const refresh of mocks.refreshers.values())
          void Promise.resolve().then(refresh)
      })
    mocks.api.get.mockClear()

    // The first round reads the running state, and its response is slow.
    holdNext = true
    await round()
    await waitFor(() => expect(held).toHaveLength(1))
    // The run completes; its signal starts the next round, which answers first.
    status = 'completed'
    await round()
    await screen.findByText('list completed')
    await screen.findByText('detail completed')
    // The first round's response arrives last and must not roll either view back.
    await act(async () => {
      held[0]()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByText('list completed')).toBeTruthy()
    expect(screen.getByText('detail completed')).toBeTruthy()
    expect(mocks.api.get).toHaveBeenCalledTimes(2)
  }
)

type QueueViews = Record<'list' | 'detail', ReturnType<typeof usePipelineQueue>>
test.each([
  [
    'an image choice from the run detail',
    'detail' as const,
    (queue: QueueViews['detail']) =>
      queue.chooseImage('saved-run', 'job', 'candidate'),
    (run: QueueRunView): QueueRunView => ({
      ...run,
      waitReason: undefined,
      attempts: [{ ...run.attempts[0], choices: { job: 'candidate' } }],
    }),
  ],
  [
    'a cancel from the list',
    'list' as const,
    (queue: QueueViews['list']) => queue.cancel('saved-run'),
    (run: QueueRunView): QueueRunView => ({
      ...run,
      status: 'cancelled',
      waitReason: undefined,
    }),
  ],
])(
  'a live response read before %s never replaces the action result in the list or the open run detail',
  async (_name, actor, perform, commit) => {
    const before = saved({ status: 'running', waitReason: 'image_choice' })
    let run = before
    let observedAt = 100
    let holdNext = false
    const held: (() => void)[] = []
    mocks.api.get.mockImplementation(async (path: string) => {
      const detail = new URL(path, 'https://example.org').searchParams.get(
        'detail'
      )
      // The response reflects the state when the request was read.
      const body = {
        runs: [run],
        observedAt,
        ...(detail === 'saved-run' ? { selected: run } : {}),
      }
      if (!holdNext) return body
      holdNext = false
      return new Promise((resolve) => held.push(() => resolve(body)))
    })
    mocks.api.send.mockImplementation(async () => {
      run = commit(run)
      observedAt += 100
      return { run }
    })
    const views = {} as QueueViews
    // Run summaries carry the status and wait, which both actions change.
    const describe = (view?: Pick<QueueRunView, 'status' | 'waitReason'>) =>
      `${view?.status} ${view?.waitReason ?? 'not waiting'}`
    function Views() {
      views.list = usePipelineQueue()
      views.detail = usePipelineQueue(undefined, undefined, 'saved-run')
      return (
        <>
          <span>list {describe(views.list.runs[0])}</span>
          <span>detail {describe(views.detail.selected)}</span>
        </>
      )
    }
    render(<Views />, { wrapper })
    await screen.findByText('list running image_choice')
    await screen.findByText('detail running image_choice')
    await waitFor(() => expect(mocks.refreshers.size).toBe(2))
    mocks.api.get.mockClear()

    // A live round reads the run before the action, and its response is slow.
    holdNext = true
    await act(async () => {
      for (const refresh of mocks.refreshers.values())
        void Promise.resolve().then(refresh)
    })
    await waitFor(() => expect(held).toHaveLength(1))
    // The action commits, and its refresh shows the result in both views.
    await act(() => perform(views[actor]))
    const result = describe(commit(before))
    await screen.findByText(`list ${result}`)
    await screen.findByText(`detail ${result}`)
    // The older live response arrives last and must not roll either view back.
    await act(async () => {
      held[0]()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.getByText(`list ${result}`)).toBeTruthy()
    expect(screen.getByText(`detail ${result}`)).toBeTruthy()
    // The action's refresh shares one request between the two views.
    expect(mocks.api.get).toHaveBeenCalledTimes(2)
  }
)

test('uncertain A then B then remount preserves A request ID', async () => {
  mocks.api.send.mockRejectedValue(new Error('Response lost'))
  const first = renderHook(usePipelineQueue, { wrapper })
  await act(async () => {
    await first.result.current.enqueue([plate], ['tag'])
  })
  const original = mocks.api.send.mock.calls[0][2].requestId
  await act(async () => {
    await first.result.current.enqueue([{ ...plate, id: 'AK.two' }], ['tag'])
  })
  first.unmount()
  const restored = renderHook(usePipelineQueue, { wrapper })
  await act(async () => {
    await restored.result.current.enqueue([plate], ['tag'])
  })
  expect(mocks.api.send.mock.calls[2][2].requestId).toBe(original)
})

test('read-only Batch rejects enqueue and flag off disables list requests', async () => {
  mocks.workspace = {
    mode: 'selected',
    id: 'batch',
    status: 'ready',
    detail: { batch: { state: 'submitted' } },
  }
  const first = renderHook(usePipelineQueue, { wrapper })
  await act(async () => {
    await first.result.current.enqueue([plate], ['tag'])
  })
  expect(mocks.api.send).not.toHaveBeenCalled()
  first.unmount()
  mocks.api.get.mockClear()
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  renderHook(usePipelineQueue, { wrapper })
  expect(mocks.api.get).not.toHaveBeenCalled()
})

test('history exposes coherent Apply, cancel/retry, durable hide, and explicit verified worker recovery', async () => {
  const completed = saved({
    id: 'completed',
    status: 'completed',
    previewOnly: false,
  })
  completed.attempts[0].endedAt = 200
  completed.attempts[0].cursor = 1
  const controls = {
    runs: [
      saved({ queueWait: 'saved_sources_worker' }),
      completed,
      saved({ id: 'failed', status: 'failed' }),
    ],
    observedAt: 250_000,
    loading: false,
    error: null,
    refresh: vi.fn(),
    action: null,
    message: '',
    cancel: vi.fn(),
    dismiss: vi.fn(),
    retry: vi.fn(),
    apply: vi.fn(),
    chooseImage: vi.fn(),
    recover: vi.fn(),
  }
  const view = render(<PipelineQueuePanel queue={controls} />)
  const cancel = screen.getByRole('button', { name: 'Cancel remaining stages' })
  fireEvent.focus(cancel)
  expect((await screen.findByRole('tooltip')).textContent).toMatch(
    /Any active stage can finish/
  )
  fireEvent.blur(cancel)
  fireEvent.click(cancel)
  expect(controls.cancel).toHaveBeenCalledWith('saved-run')
  expect(
    screen.getByText('Waiting for a worker with saved-source support')
  ).toBeTruthy()
  expect(
    screen.getByRole('article', { name: 'Pipeline run completed' })
  ).toBeTruthy()
  const completedCard = within(
    screen.getByRole('article', { name: 'Pipeline run completed' })
  )
  expect(
    completedCard
      .getByRole('link', { name: 'View Tag results' })
      .getAttribute('href')
  ).toBe('/pipeline/runs/completed?batch=batch&stage=tag')
  expect(screen.queryByRole('link', { name: /^View results$/i })).toBeNull()
  const remove = screen
    .getByRole('article', { name: 'Pipeline run failed' })
    .querySelector('button[aria-label="Remove run card"]')!
  fireEvent.focus(remove)
  expect((await screen.findByRole('tooltip')).textContent).toMatch(
    /Move this card to History/
  )
  fireEvent.blur(remove)
  fireEvent.click(remove)
  expect(controls.dismiss).toHaveBeenCalledWith('failed')
  fireEvent.click(screen.getByRole('button', { name: 'Retry pending stages' }))
  expect(controls.retry).toHaveBeenCalledWith('failed')
  view.rerender(
    <PipelineQueuePanel
      queue={{
        ...controls,
        runs: [saved({ id: 'failed', status: 'failed', dismissedAt: 200 })],
      }}
    />
  )
  expect(
    screen.queryByRole('article', { name: 'Pipeline run failed' })
  ).toBeNull()
  expect(screen.getByText('No active runs')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'History' }))
  expect(screen.getByRole('link', { name: 'Run failed' })).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('link', { name: 'Run failed' }), {
    key: 'Escape',
  })
  const stale = saved({
    status: 'running',
    editable: false,
    waitReason: 'recovery',
    cancelRequestedAt: 100,
    jobs: [
      {
        id: 'job',
        batchId: 'batch',
        plateId: 'AK.one',
        requestedBy: 'editor',
        env: 'preview:local-pipeline-test',
        inputHash: 'hash',
        state: 'claimed',
        createdAt: 100,
        claimId: 'claim',
        workerId: 'stopped-worker',
        queueAttempt: 1,
        queueStep: 0,
      },
    ],
  })
  view.rerender(
    <>
      <PipelineQueuePanel queue={{ ...controls, runs: [stale] }} />
      <PipelineRunResults run={stale} actions={controls} />
    </>
  )
  expect(screen.getByText(/Cancellation requested/)).toBeTruthy()
  expect(
    screen.queryByRole('button', { name: 'Retry pending stages' })
  ).toBeNull()
  fireEvent.click(screen.getByText('Recover a stopped worker'))
  const button = screen.getByRole('button', {
    name: 'Release verified stopped worker',
  }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(screen.getByLabelText('I verified this worker has stopped'))
  expect(button.disabled).toBe(false)
  fireEvent.click(button)
  expect(controls.recover).toHaveBeenCalledWith('saved-run', 'job', 'claim')
})

test('the run rail keeps completed cards in order and follows a new run to the right', () => {
  const older = saved({
    id: 'older',
    status: 'completed',
    createdAt: 100,
    queuedAt: 100,
  })
  const active = saved({
    id: 'active',
    status: 'running',
    createdAt: 200,
    queuedAt: 200,
  })
  const newest = saved({
    id: 'newest',
    status: 'queued',
    createdAt: 300,
    queuedAt: 300,
  })
  const queue = {
    runs: [active, older],
    loading: false,
    error: null,
    refresh: vi.fn(),
    action: null,
    message: '',
    cancel: vi.fn(),
    dismiss: vi.fn(),
    retry: vi.fn(),
  }
  const view = render(<PipelineQueuePanel queue={queue} />)
  const rail = screen.getByRole('region', {
    name: 'Plate Pipeline runs, scroll horizontally',
  })
  const order = () =>
    within(rail)
      .getAllByRole('article')
      .map((card) => card.getAttribute('aria-label'))
  expect(order()).toEqual(['Pipeline run older', 'Pipeline run active'])

  Object.defineProperty(rail, 'scrollWidth', { value: 1500 })
  view.rerender(
    <PipelineQueuePanel
      queue={{
        ...queue,
        runs: [newest, { ...active, status: 'completed' }, older],
      }}
    />
  )
  expect(order()).toEqual([
    'Pipeline run older',
    'Pipeline run active',
    'Pipeline run newest',
  ])
  expect(rail.scrollLeft).toBe(1500)

  rail.scrollLeft = 25
  view.rerender(
    <PipelineQueuePanel
      queue={{
        ...queue,
        runs: [
          { ...newest, status: 'running' },
          { ...active, status: 'completed' },
          { ...older, dismissedAt: 400 },
        ],
      }}
    />
  )
  expect(order()).toEqual(['Pipeline run active', 'Pipeline run newest'])
  expect(rail.scrollLeft).toBe(25)
})

test('plate steps are always visible for every displayed run', () => {
  const queued = saved({ id: 'queued' })
  const running = saved({ id: 'running', status: 'running' })
  const queue = {
    runs: [queued, running],
    loading: false,
    error: null,
    refresh: vi.fn(),
    action: null,
    message: '',
    cancel: vi.fn(),
    dismiss: vi.fn(),
    retry: vi.fn(),
  }
  const view = render(<PipelineQueuePanel queue={queue} />)
  const rail = screen.getByRole('region', {
    name: 'Plate Pipeline runs, scroll horizontally',
  })
  const timelines = () =>
    within(rail).queryAllByRole('region', { name: 'Pipeline steps by plate' })
  expect(timelines()).toHaveLength(2)
  expect(screen.queryByRole('group', { name: 'Pipeline display' })).toBeNull()
  view.rerender(
    <PipelineQueuePanel
      queue={{
        ...queue,
        runs: [
          { ...running, status: 'completed' },
          { ...queued, dismissedAt: 300 },
        ],
      }}
    />
  )
  expect(timelines()).toHaveLength(1)
})

test('the drawer shows pipeline types and keeps open runs across polling and new starts', () => {
  const running = saved({
    id: 'active',
    batchName: 'Alaska pipeline',
    status: 'running',
    plateIds: ['AK.one', 'AK.two', 'AK.three'],
    stages: ['enhance-image', 'research'],
  })
  running.progress = {
    workerIds: [],
    steps: [
      {
        index: 0,
        plateId: 'AK.one',
        plateName: 'One',
        stage: 'enhance-image',
        status: 'completed',
      },
      {
        index: 1,
        plateId: 'AK.one',
        plateName: 'One',
        stage: 'research',
        status: 'running',
        phaseIndex: 1,
      },
      {
        index: 2,
        plateId: 'AK.two',
        plateName: 'Two',
        stage: 'research',
        status: 'failed',
        reason: 'no_sources',
      },
      {
        index: 3,
        plateId: 'AK.three',
        plateName: 'Three',
        stage: 'research',
        status: 'completed',
      },
    ],
  }
  const finished = saved({
    id: 'finished',
    createdAt: 50,
    queuedAt: 50,
    status: 'completed',
  })
  const queued = saved({ id: 'queued', createdAt: 200, queuedAt: 200 })
  const queue = {
    runs: [finished, running],
    loading: false,
    error: null,
    refresh: vi.fn(),
    action: null,
    message: '',
    cancel: vi.fn(),
    dismiss: vi.fn(),
    retry: vi.fn(),
  }
  const view = render(<PipelineQueuePanel queue={queue} stacked />)
  const active = screen.getByRole('button', {
    name: /Enhance image \+ Research \/ enrich.*Alaska pipeline.*3 plates.*Running/,
  })
  const stageSummary = () =>
    within(
      within(active.closest('article')!).getByRole('list', {
        name: 'Run stages',
      })
    )
  expect(active.getAttribute('aria-expanded')).toBe('true')
  expect(stageSummary().getByText('1 done · 1 running · 1 failed')).toBeTruthy()
  expect(stageSummary().getByText('Draft description & story')).toBeTruthy()
  expect(screen.getByText('No usable source page was found.')).toBeTruthy()
  expect(
    screen.getByRole('link', { name: 'View Enhance image results' })
  ).toBeTruthy()

  const older = screen.getByRole('button', {
    name: /Tag.*Run finished.*1 plate.*Finished/,
  })
  fireEvent.click(older)
  view.rerender(
    <PipelineQueuePanel
      queue={{ ...queue, runs: [finished, running, queued] }}
      stacked
    />
  )
  const newest = screen.getByRole('button', {
    name: /Tag.*Run queued.*1 plate.*Queued/,
  })
  expect(older.getAttribute('aria-expanded')).toBe('true')
  expect(active.getAttribute('aria-expanded')).toBe('true')
  expect(newest.getAttribute('aria-expanded')).toBe('false')
  expect(stageSummary().getByText('Draft description & story')).toBeTruthy()
  view.rerender(
    <PipelineQueuePanel
      queue={{ ...queue, runs: [finished, running, queued] }}
      stacked
      requestedRunId="queued"
    />
  )
  expect(active.getAttribute('aria-expanded')).toBe('true')
  expect(older.getAttribute('aria-expanded')).toBe('true')
  expect(newest.getAttribute('aria-expanded')).toBe('true')
})

test('the drawer groups running, queued and finished runs, and marks worker pickup as waiting', () => {
  const active = saved({ id: 'active', status: 'running' })
  // One curator's hosted runs can run at the same time.
  const alsoActive = saved({ id: 'also-active', status: 'running' })
  const first = saved({
    id: 'first',
    createdAt: 200,
    queuedAt: 200,
    enqueueSequence: 2,
    queueWait: 'worker_claim',
  })
  const second = saved({
    id: 'second',
    createdAt: 201,
    queuedAt: 201,
    enqueueSequence: 3,
    queueWait: 'prior_run',
  })
  const settled = saved({
    id: 'settled',
    status: 'completed',
    createdAt: 50,
    queuedAt: 50,
  })
  const queue = {
    runs: [second, settled, alsoActive, active, first],
    loading: false,
    error: null,
    refresh: vi.fn(),
    action: null,
    message: '',
    cancel: vi.fn(),
    dismiss: vi.fn(),
    retry: vi.fn(),
  }
  render(<PipelineQueuePanel queue={queue} stacked requestedRunId="first" />)
  const rail = within(
    screen.getByRole('region', { name: 'Plate Pipeline runs' })
  )
  expect(
    rail.getAllByRole('heading').map((heading) => heading.textContent)
  ).toEqual(['Running', 'Queue', 'Recent runs'])
  expect(
    rail
      .getAllByRole('article')
      .map((article) => article.getAttribute('aria-label'))
  ).toEqual([
    'Pipeline run active',
    'Pipeline run also-active',
    'Pipeline run first',
    'Pipeline run second',
    'Pipeline run settled',
  ])
  const waiting = within(
    rail.getByRole('article', { name: 'Pipeline run first' })
  )
  expect(
    waiting.getByRole('button', { name: /Run first.*Waiting/ })
  ).toBeTruthy()
  expect(
    waiting
      .getByRole('list', { name: 'Run stages' })
      .querySelector('[data-status="pickup"]')
  ).toBeTruthy()
  expect(
    waiting.queryByText('Waiting for the local worker to pick up this step')
  ).toBeNull()
  fireEvent.click(rail.getByRole('button', { name: /Run second.*Queued/ }))
  expect(
    within(
      rail.getByRole('article', { name: 'Pipeline run second' })
    ).getByText('Waiting for other runs in the queue')
  ).toBeTruthy()
})

test('running cards open by default and only reopen for a new start', () => {
  const first = saved({ id: 'first', status: 'running' })
  const next = saved({ id: 'next', enqueueSequence: 2 })
  const queue = {
    runs: [first, next],
    loading: false,
    error: null,
    refresh: vi.fn(),
    action: null,
    message: '',
    cancel: vi.fn(),
    dismiss: vi.fn(),
    retry: vi.fn(),
  }
  const view = render(<PipelineQueuePanel queue={queue} stacked />)
  const button = (id: string) =>
    within(
      screen.getByRole('article', { name: `Pipeline run ${id}` })
    ).getByRole('button', { name: new RegExp(`Run ${id}`) })
  const expanded = (id: string) => button(id).getAttribute('aria-expanded')
  expect(expanded(first.id)).toBe('true')
  expect(expanded(next.id)).toBe('false')

  fireEvent.click(button(first.id))
  const started = { ...next, status: 'running' as const }
  view.rerender(
    <PipelineQueuePanel queue={{ ...queue, runs: [first, started] }} stacked />
  )
  expect(expanded(first.id)).toBe('false')
  expect(expanded(next.id)).toBe('true')

  fireEvent.click(button(next.id))
  view.rerender(
    <PipelineQueuePanel
      queue={{ ...queue, runs: [first, { ...started, updatedAt: 400 }] }}
      stacked
    />
  )
  expect(expanded(next.id)).toBe('false')
  view.rerender(
    <PipelineQueuePanel
      queue={{
        ...queue,
        runs: [
          { ...first, status: 'completed' },
          { ...started, enqueueSequence: 3, updatedAt: 500 },
        ],
      }}
      stacked
    />
  )
  expect(expanded(next.id)).toBe('true')
})

test('the drawer opens plate steps when a queued run starts and respects manual disclosure', () => {
  const run = saved()
  const queue = {
    runs: [run],
    loading: false,
    error: null,
    refresh: vi.fn(),
    action: null,
    message: '',
    cancel: vi.fn(),
    dismiss: vi.fn(),
    retry: vi.fn(),
  }
  const view = render(<PipelineQueuePanel queue={queue} stacked />)
  const setStatus = (status: QueueRunView['status']) =>
    view.rerender(
      <PipelineQueuePanel
        queue={{ ...queue, runs: [{ ...run, status }] }}
        stacked
      />
    )
  const timeline = () =>
    screen.queryByRole('region', { name: 'Pipeline steps by plate' })

  expect(timeline()).toBeNull()
  setStatus('running')
  expect(timeline()).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Hide plates' }))
  setStatus('running')
  expect(timeline()).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'View plates' }))
  setStatus('completed')
  expect(timeline()).toBeTruthy()
})

test('the vertical wheel scrolls the rail except over a watch timeline or at a rail edge', () => {
  const queue = {
    runs: [saved()],
    loading: false,
    error: null,
    refresh: vi.fn(),
    action: null,
    message: '',
    cancel: vi.fn(),
    dismiss: vi.fn(),
    retry: vi.fn(),
  }
  render(<PipelineQueuePanel queue={queue} />)
  const rail = screen.getByRole('region', {
    name: 'Plate Pipeline runs, scroll horizontally',
  })
  const stage = within(rail).getByRole('button', { name: /Tag: Waiting/ })
  let scrollLeft = 100
  Object.defineProperty(rail, 'scrollLeft', {
    get: () => scrollLeft,
    set: (value) => {
      scrollLeft = Math.max(0, Math.min(200, value))
    },
  })
  const wheel = (target: Element, options: WheelEventInit) => {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ...options,
    })
    fireEvent(target, event)
    return event.defaultPrevented
  }
  expect(
    wheel(stage, { deltaY: 2, deltaMode: WheelEvent.DOM_DELTA_LINE })
  ).toBe(true)
  expect(scrollLeft).toBe(132)
  expect(wheel(stage, { deltaX: 60, deltaY: 20 })).toBe(false)
  expect(wheel(stage, { deltaY: 60, ctrlKey: true })).toBe(false)
  expect(scrollLeft).toBe(132)
  const watch = within(rail).getByRole('list', {
    name: 'AK.one pipeline steps',
  })
  expect(wheel(watch, { deltaY: 60 })).toBe(false)
  expect(scrollLeft).toBe(132)
  rail.scrollLeft = 200
  expect(wheel(stage, { deltaY: 60 })).toBe(false)
})

test('the requester, workflow, and activity appear in that order in the card header', async () => {
  const run = saved({
    status: 'running',
    requestedByName: 'Morgan',
    stages: ['enhance-image', 'tag'],
  })
  run.progress = {
    workerIds: [],
    startedAt: 200,
    workflowUrl: 'http://localhost:3456/run/wrun_exact',
    steps: [
      {
        index: 0,
        plateId: plate.id,
        plateName: 'One',
        stage: 'enhance-image',
        status: 'completed',
        durationMs: 6000,
      },
      {
        index: 1,
        plateId: plate.id,
        plateName: 'One',
        stage: 'tag',
        status: 'running',
      },
    ],
  }
  const queue = {
    runs: [run],
    observedAt: 9200,
    loading: false,
    error: null,
    refresh: vi.fn(),
    action: null,
    message: '',
    cancel: vi.fn(),
    dismiss: vi.fn(),
    retry: vi.fn(),
  }
  render(<PipelineQueuePanel queue={queue} />)
  const card = screen.getByRole('article', { name: 'Pipeline run saved-run' })
  const header = within(card.querySelector('header')!)
  const avatar = header.getByRole('button', { name: 'Started by Morgan' })
  expect(header.queryByText(/Started by|Morgan/)).toBeNull()
  expect(
    header.getByRole('button', { name: 'Cancel remaining stages' })
  ).toBeTruthy()
  fireEvent.focus(avatar)
  expect((await screen.findByRole('tooltip')).textContent).toBe(
    'Started by Morgan'
  )
  fireEvent.blur(avatar)
  const reference = header.getByRole('link', { name: 'Run saved-run' })
  const activity = header.getByRole('button', { name: 'Run activity' })
  expect(avatar.nextElementSibling).toBe(reference)
  expect(reference.nextElementSibling).toBe(activity)
  expect(within(card).queryByText(/Elapsed|Requested|00:06/)).toBeNull()
  fireEvent.focus(activity)
  expect((await screen.findByRole('tooltip')).textContent).toMatch(
    /Requested.*Elapsed 00:09/
  )
  fireEvent.blur(activity)
  const result = within(card).getByRole('link', {
    name: 'View Enhance image results',
  })
  expect(result.getAttribute('href')).toBe(
    '/pipeline/runs/saved-run?batch=batch&stage=enhance-image'
  )
  expect(result.textContent).toBe('Enhance image')
  expect(
    within(card).queryByRole('link', { name: 'View Tag results' })
  ).toBeNull()
  expect(within(card).queryByRole('button', { name: 'Plate steps' })).toBeNull()
  expect(within(card.querySelector('footer')!).queryByRole('button')).toBeNull()
  expect(within(card.querySelector('footer')!).queryByRole('link')).toBeNull()
})

test('footer status applies to whole canceled or skipped runs only', () => {
  const step = {
    index: 0,
    plateId: plate.id,
    plateName: 'One',
    stage: 'enhance-image' as const,
    status: 'skipped' as const,
  }
  const skipped = saved({
    id: 'skipped',
    status: 'completed',
    stages: ['enhance-image'],
    progress: { workerIds: [], steps: [step] },
  })
  const mixed = saved({
    id: 'mixed',
    status: 'completed',
    stages: ['enhance-image', 'tag'],
    plateIds: [plate.id, 'AK.two'],
    progress: {
      workerIds: [],
      steps: [
        step,
        {
          ...step,
          index: 1,
          plateId: 'AK.two',
          plateName: 'Two',
          stage: 'tag',
          status: 'completed',
        },
      ],
    },
  })
  const canceled = saved({
    id: 'canceled',
    status: 'cancelled',
    cancelRequestedAt: 150,
    stages: ['enhance-image'],
    progress: { workerIds: [], steps: [{ ...step, status: 'cancelled' }] },
  })
  const queue = {
    runs: [skipped, mixed, canceled],
    loading: false,
    error: null,
    refresh: vi.fn(),
    action: null,
    message: '',
    cancel: vi.fn(),
    dismiss: vi.fn(),
    retry: vi.fn(),
  }
  render(<PipelineQueuePanel queue={queue} />)
  const card = (id: string) =>
    screen.getByRole('article', { name: `Pipeline run ${id}` })
  expect(
    within(card('skipped').querySelector('footer')!).getByText('Skipped')
  ).toBeTruthy()
  const canceledFooter = within(card('canceled').querySelector('footer')!)
  expect(
    canceledFooter.getAllByText(/^Cancel+ed$/).map((node) => node.textContent)
  ).toEqual(['Canceled'])
  expect(
    within(card('mixed').querySelector('footer')!).queryByText(
      /^(Skipped|Canceled)$/
    )
  ).toBeNull()
  expect(
    within(card('skipped')).getByRole('link', {
      name: 'View Enhance image results',
    }).textContent
  ).toBe('Enhance image')
  expect(
    within(card('canceled')).getByRole('link', {
      name: 'View Enhance image results',
    }).textContent
  ).toBe('Enhance image')
})

test('the form preserves selected stages while selecting plates and resets after a confirmed run', async () => {
  const enqueue = vi.fn().mockResolvedValue(saved())
  const selected = [plate, { ...plate, id: 'AK.two' }]
  plateSelection.clear()
  render(
    <>
      <SelectionPresence />
      <PipelineRunControls
        batchPlates={[plate]}
        stateName="Alaska"
        queue={{
          runs: [],
          action: null,
          message: '',
          disabledReason: undefined,
          enqueue,
        }}
      />
      <p>Dashboard background</p>
    </>
  )
  const trigger = screen.getByRole('button', { name: 'Run pipeline' })
  const tag = () =>
    screen.getByRole<HTMLInputElement>('checkbox', { name: 'Tag' })
  const start = () =>
    screen.getByRole<HTMLButtonElement>('button', { name: 'Start Run' })
  fireEvent.click(trigger)
  const count = screen.getByText('Selected plates')
  expect(count.querySelector('strong')?.textContent).toBe('0')
  expect(
    screen.getByText('Select plates on the dashboard to start a run.')
  ).toBeTruthy()
  expect(screen.getByText('Up to 200 plates per run')).toBeTruthy()
  expect(
    screen.queryByText(
      /Run on|Plate limit|Preview only|New draft|Choose stages|Validated results/
    )
  ).toBeNull()
  expect(screen.queryByRole('checkbox', { name: 'Colors' })).toBeNull()
  expect(screen.queryByRole('checkbox', { name: 'Order' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Queue Run' })).toBeNull()
  expect(tag().checked).toBe(false)
  expect(start().disabled).toBe(true)
  fireEvent.click(count)
  fireEvent.click(screen.getByText('Tag'))
  expect(tag().checked).toBe(true)
  expect(start().disabled).toBe(true)
  fireEvent.click(trigger)
  act(() => plateSelection.replace(selected))
  fireEvent.click(trigger)
  expect(tag().checked).toBe(true)
  expect(start().disabled).toBe(false)
  expect(plateSelection.snapshot()).toEqual(selected)
  fireEvent.click(start())
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Start Run' })).toBeNull()
  )
  expect(enqueue.mock.calls[0]?.slice(0, 2)).toEqual([selected, ['tag']])
  fireEvent.click(trigger)
  expect(tag().checked).toBe(false)
  expect(start().disabled).toBe(true)
  fireEvent.click(trigger)
  fireEvent.click(screen.getByText('Dashboard background'))
  expect(plateSelection.snapshot()).toEqual([])
})

test('the stage cards show icons and diagrams before the editable options', () => {
  const enqueue = vi.fn()
  render(
    <PipelineRunControls
      batchPlates={[]}
      stateName="Alaska"
      queue={{
        runs: [],
        action: null,
        message: '',
        disabledReason: undefined,
        enqueue,
      }}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  for (const stage of [
    'Research / enrich',
    'Find image',
    'Enhance image',
    'Tag',
    'Group',
  ]) {
    expect(
      screen.getByText(stage).querySelector('svg')?.getAttribute('aria-hidden')
    ).toBe('true')
  }
  const flows = screen.getAllByRole('list', { name: / steps$/ })
  expect(
    flows.map((flow) =>
      Array.from(
        flow.querySelectorAll('[role="listitem"]'),
        (node) => node.textContent
      )
    )
  ).toEqual([
    ['Find sources', 'Draft description & story', 'Validate result'],
    ['Search Commons', 'Check images', 'Offer candidates'],
    ['Apply edits', 'Export WebP'],
    ['Embed images', 'Compare', 'Propose families'],
  ])
  expect(flows.map((flow) => flow.style.gridTemplateColumns)).toEqual([
    'repeat(3, max-content)',
    'repeat(3, max-content)',
    'repeat(2, max-content)',
    'repeat(3, max-content)',
  ])
  const researchFlow = screen.getByRole('list', {
    name: 'Research / enrich steps',
  })
  fireEvent.click(
    screen.getByRole('button', { name: 'More options for Research / enrich' })
  )
  const options = screen.getByRole('button', { name: 'Research edits' })
  expect(
    researchFlow.compareDocumentPosition(options) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
})

test.each(['queued', 'running'] as const)(
  'only Queue Run appears when existing work is %s',
  async (status) => {
    const enqueue = vi.fn().mockResolvedValue(saved())
    render(
      <PipelineRunControls
        batchPlates={[]}
        stateName="Alaska"
        queue={{
          runs: [saved({ status })],
          action: null,
          message: '',
          disabledReason: undefined,
          enqueue,
        }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
    fireEvent.click(
      screen.getByRole('button', { name: 'More options for Tag' })
    )
    const only = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Only under-tagged plates (fewer than 3 tags)',
    })
    expect(only.disabled).toBe(false)
    fireEvent.click(only)
    const tag = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Tag' })
    expect(tag.checked).toBe(false)
    fireEvent.click(tag)
    expect(screen.queryByRole('button', { name: 'Start Run' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Queue Run' }))
    await waitFor(() =>
      expect(enqueue).toHaveBeenCalledWith(
        [plate],
        ['tag'],
        'desktop-gemma4-12b',
        { tag: { onlyUnderTagged: true } },
        false,
        'desktop-gemma4-12b',
        undefined,
        'Alaska pipeline'
      )
    )
    expect(plateSelection.snapshot()).toEqual([plate])
  }
)

test('Tag settings accept a gateway model before Tag is selected', async () => {
  const enqueue = vi.fn().mockResolvedValue(saved())
  render(
    <PipelineRunControls
      batchPlates={[plate]}
      stateName="Alaska"
      queue={{
        runs: [],
        action: null,
        message: '',
        disabledReason: undefined,
        enqueue,
      }}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('button', { name: 'More options for Tag' }))
  const picker = screen.getByRole('button', { name: 'Tagging model' })
  fireEvent.keyDown(picker, { key: 'Enter' })
  fireEvent.click(
    screen.getByRole('menuitemradio', { name: /Gemma 4 26B.*0\.0003/ })
  )
  fireEvent.click(screen.getByRole('checkbox', { name: 'Tag' }))
  fireEvent.click(screen.getByRole('button', { name: 'Start Run' }))
  await waitFor(() =>
    expect(enqueue).toHaveBeenCalledWith(
      [plate],
      ['tag'],
      'gateway-gemma4-26b',
      { tag: { onlyUnderTagged: false } },
      false,
      'gateway-gemma4-26b',
      undefined,
      'Alaska pipeline'
    )
  )
})

test.each([
  ['Gemini 2.5 Flash Lite', 'eve-gemini-2-5-flash-lite'],
  ['Gemma 4 26B', 'eve-gemma4-26b'],
])(
  'the combined Research control enqueues hosted %s and its policy once',
  async (label, modelId) => {
    const plates = [plate, { ...plate, id: 'AK.two' }]
    plateSelection.replace(plates)
    mocks.api.get.mockImplementation(async (path) =>
      path === '/api/research/models'
        ? { models: RESEARCH_MODELS, default: RESEARCH_MODELS[0].id }
        : { runs: [] }
    )
    function Controls() {
      const queue = usePipelineQueue()
      return (
        <PipelineRunControls
          batchPlates={plates}
          stateName="Alaska"
          queue={queue}
        />
      )
    }
    render(<Controls />, { wrapper })
    fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Research / enrich' }))
    for (const name of ['Wiki link', 'Describe', 'Story'])
      expect(screen.queryByRole('checkbox', { name })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Research edits' })).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: 'More options for Research / enrich' })
    )
    const policy = screen.getByRole('button', { name: 'Research edits' })
    expect(policy.textContent).toBe('Fill missing')
    const picker = await screen.findByRole('button', { name: 'Research model' })
    expect(picker.textContent).toContain('On-device worker (Ollama)')
    fireEvent.pointerDown(picker, { button: 0, pointerType: 'mouse' })
    const hosted = screen.getByRole('menuitemradio', {
      name: `Hosted research (Eve) · ${label}`,
    })
    expect(
      screen.getByRole('menuitemradio', {
        name: 'On-device worker (Ollama) · Gemma 4 26B',
      })
    ).toBeTruthy()
    expect(
      screen.getByRole('dialog', { name: 'Run pipeline' }).contains(hosted)
    ).toBe(true)
    fireEvent.click(hosted)
    expect(picker.textContent).toContain(`Hosted research (Eve) · ${label}`)
    fireEvent.keyDown(policy, { key: 'Enter' })
    fireEvent.click(
      screen.getByRole('menuitemradio', { name: 'Replace existing' })
    )
    expect(plateSelection.snapshot()).toEqual(plates)
    fireEvent.click(screen.getByRole('button', { name: 'Start Run' }))
    await waitFor(() =>
      expect(mocks.api.send).toHaveBeenCalledExactlyOnceWith(
        'POST',
        '/api/local-pipeline/runs/selection',
        {
          requestId: expect.any(String),
          batchName: 'Alaska pipeline',
          plateIds: ['AK.one', 'AK.two'],
          stages: ['research'],
          options: { research: { policy: 'replace' } },
          previewOnly: false,
          researchModelId: modelId,
        }
      )
    )
  }
)

test('saved-source research is visible in the diagram and reaches the queued options', async () => {
  mocks.api.get.mockResolvedValue({
    models: RESEARCH_MODELS,
    default: RESEARCH_MODELS[0].id,
  })
  const enqueue = vi.fn().mockResolvedValue(saved())
  render(
    <PipelineRunControls
      batchPlates={[]}
      stateName="Alaska"
      queue={{
        runs: [],
        action: null,
        message: '',
        disabledReason: undefined,
        enqueue,
      }}
    />,
    { wrapper }
  )
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(
    screen.getByRole('button', { name: 'More options for Research / enrich' })
  )
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Use saved sources only' })
  )
  expect(screen.getByText('Use saved sources')).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('button', { name: 'Research edits' }), {
    key: 'Enter',
  })
  fireEvent.click(
    screen.getByRole('menuitemradio', { name: 'Replace existing' })
  )
  expect(screen.getByText('Find sources')).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('button', { name: 'Research edits' }), {
    key: 'Enter',
  })
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Fill missing' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Research / enrich' }))
  await screen.findByRole('button', { name: 'Research model' })
  fireEvent.click(screen.getByRole('button', { name: 'Start Run' }))
  await waitFor(() =>
    expect(enqueue).toHaveBeenCalledWith(
      [plate],
      ['research'],
      undefined,
      { research: { policy: 'fill-missing', reuseSavedSources: true } },
      false,
      undefined,
      RESEARCH_MODELS[0].id,
      'Alaska pipeline'
    )
  )
})

test('stage results can revert the whole run and list the fields kept', async () => {
  mocks.revertRun.mockReset().mockResolvedValue({
    reverted: 2,
    skipped: [{ plateId: 'AK.one', field: 'description' }],
  })
  const run = saved({
    status: 'completed',
    batchId: 'shared-draft-test',
    previewOnly: false,
    incrementalDrafts: true,
    draftPlateIds: ['AK.one'],
  })
  render(<PipelineRunResults run={run} actions={resultActions} stage="tag" />)
  fireEvent.click(screen.getByRole('button', { name: 'Revert pipeline run' }))
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Revert run',
    })
  )
  expect(mocks.revertRun).toHaveBeenCalledWith(run.id, {
    attempt: 1,
    jobIds: [],
  })
  expect(
    await screen.findByText('1 field kept because it changed later')
  ).toBeTruthy()
  expect(screen.getByText('AK.one · Description')).toBeTruthy()
})

test('Preview hides every run Apply control and explains that a normal rerun is required', () => {
  const run = saved({ status: 'completed', previewOnly: true })
  render(<PipelineRunResults run={run} actions={resultActions} />)
  expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull()
  expect(screen.getByText(/Run again without Preview only/)).toBeTruthy()
})

test('each specialized image result names its plate in a multi-plate completed Preview', () => {
  const plates = ['One', 'Two'].map((name) => ({
    id: `AK.${name.toLowerCase()}`,
    slug: name.toLowerCase(),
    state: 'AK',
    image: '',
    displayName: name,
    tags: [],
  }))
  const candidate = {
    id: 'photo',
    title: 'Photo',
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Plate.jpg',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Plate.jpg',
    width: 640,
    height: 320,
    sha256: 'a'.repeat(64),
  }
  const run = saved({
    status: 'completed',
    previewOnly: true,
    plateIds: plates.map((plate) => plate.id),
  })
  run.attempts[0].projection = {
    baselineVersion: 1,
    plates: Object.fromEntries(
      plates.map((plate) => [
        plate.id,
        {
          batchInput: plate,
          executionPlate: plate,
          batchInputHash: 'hash',
          executionHash: 'hash',
          sourceJobIds: [],
        },
      ])
    ),
  }
  run.jobs = plates.map((plate) => ({
    id: `image-${plate.id}`,
    batchId: 'batch',
    plateId: plate.id,
    requestedBy: 'editor',
    env: run.env,
    inputHash: 'hash',
    state: 'completed',
    createdAt: 100,
    result: {
      suggestions: [],
      fieldSuggestion: {
        kind: 'image',
        stage: 'find-image',
        candidates: [candidate],
        sources: [candidate.imageUrl, candidate.sourceUrl],
      },
      backend: 'fixture',
      model: 'fixture',
      promptVersion: 'v1',
      durationMs: 0,
    },
  }))
  render(<PipelineRunResults run={run} actions={resultActions} />)
  fireEvent.click(screen.getByRole('button', { name: 'View changes for One' }))
  expect(screen.getByRole('dialog', { name: 'One' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Close plate changes' }))
  fireEvent.click(screen.getByRole('button', { name: 'View changes for Two' }))
  expect(screen.getByRole('dialog', { name: 'Two' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^Apply/ })).toBeNull()
})

test('research model discovery distinguishes loading, failure, empty, and desktop-only catalogs', async () => {
  localStorage.setItem('research-model:v1', RESEARCH_MODELS[2].id)
  let failDiscovery!: (error: Error) => void
  mocks.api.get
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          failDiscovery = reject
        })
    )
    .mockResolvedValueOnce({ models: [], default: RESEARCH_MODELS[2].id })
  const enqueue = vi.fn().mockResolvedValue(saved())
  const controls = (
    <PipelineRunControls
      batchPlates={[plate]}
      stateName="Alaska"
      queue={{
        runs: [],
        action: null,
        message: '',
        disabledReason: undefined,
        enqueue,
      }}
    />
  )
  const initial = render(controls, { wrapper })
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Research / enrich' }))
  fireEvent.click(
    screen.getByRole('button', { name: 'More options for Research / enrich' })
  )
  expect(screen.getByRole('status').textContent).toBe(
    'Loading research models…'
  )
  expect(
    (screen.getByRole('button', { name: 'Start Run' }) as HTMLButtonElement)
      .disabled
  ).toBe(true)
  failDiscovery(new Error('Offline'))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('No research models are available.')
  expect(
    (screen.getByRole('button', { name: 'Start Run' }) as HTMLButtonElement)
      .disabled
  ).toBe(true)
  expect(enqueue).not.toHaveBeenCalled()
  initial.unmount()

  mocks.api.get.mockResolvedValueOnce({
    models: RESEARCH_MODELS.slice(0, 2),
    default: RESEARCH_MODELS[2].id,
  })
  render(controls, { wrapper })
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Research / enrich' }))
  fireEvent.click(
    screen.getByRole('button', { name: 'More options for Research / enrich' })
  )
  const picker = await screen.findByRole('button', { name: 'Research model' })
  fireEvent.keyDown(picker, { key: 'Enter' })
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(2)
  expect(
    screen.queryByRole('menuitemradio', { name: /Hosted research/ })
  ).toBeNull()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(screen.getByRole('dialog', { name: 'Run pipeline' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Start Run' }))
  await waitFor(() =>
    expect(enqueue).toHaveBeenCalledWith(
      [plate],
      ['research'],
      undefined,
      { research: { policy: 'fill-missing' } },
      false,
      undefined,
      RESEARCH_MODELS[0].id,
      'Alaska pipeline'
    )
  )
})

test('Fill missing explains why a complete Batch selection has no research to run', async () => {
  const complete: PlateCardData = {
    ...plate,
    checks: {
      ...plate.checks,
      description: { value: 'Existing description', status: 'good' },
    },
    wikiUrl: 'https://example.org/wiki',
    firstIssuedYear: 1976,
    funFacts: [
      { text: 'Existing fact', sourceUrl: 'https://example.org/fact' },
    ],
    readMore: [
      {
        site: 'Museum',
        title: 'Existing source',
        url: 'https://example.org/history',
      },
    ],
  }
  plateSelection.replace([complete])
  const enqueue = vi.fn()
  mocks.api.get.mockResolvedValue({
    models: RESEARCH_MODELS,
    default: RESEARCH_MODELS[0].id,
  })
  render(
    <PipelineRunControls
      batchPlates={[complete]}
      stateName="Alaska"
      queue={{
        runs: [],
        action: null,
        message: '',
        disabledReason: undefined,
        enqueue,
      }}
    />,
    { wrapper }
  )
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Research / enrich' }))
  fireEvent.click(
    screen.getByRole('button', { name: 'More options for Research / enrich' })
  )
  expect(screen.getByText(/Research fields are filled/)).toBeTruthy()
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Start Run' })
      .disabled
  ).toBe(true)
  fireEvent.keyDown(screen.getByRole('button', { name: 'Research edits' }), {
    key: 'Enter',
  })
  fireEvent.click(
    screen.getByRole('menuitemradio', { name: 'Replace existing' })
  )
  await screen.findByRole('button', { name: 'Research model' })
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Start Run' })
      .disabled
  ).toBe(false)
})

test('Group is work in progress: the run menu disables it even when the worker reports every capability', () => {
  const enqueue = vi.fn()
  const capabilities = {
    ...imageGroupCapabilities({
      embeddings: true,
      backgroundMask: true,
      visionTiebreak: true,
    }),
    reportedAt: 100,
    pollIntervalMs: 1000,
  }
  render(
    <PipelineRunControls
      batchPlates={[plate]}
      stateName="Alaska"
      queue={{
        runs: [],
        action: null,
        message: '',
        disabledReason: undefined,
        enqueue,
        capabilities,
      }}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  const group = screen.getByRole<HTMLInputElement>('checkbox', {
    name: 'Group',
  })
  expect(group.disabled).toBe(true)
  expect(
    screen.getByText(
      'Work in progress: proposed families will need your approval'
    )
  ).toBeTruthy()
  expect(group.checked).toBe(false)
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Start Run' })
      .disabled
  ).toBe(true)
  expect(enqueue).not.toHaveBeenCalled()
})

test('a method control with multiple available choices exposes a selector', () => {
  const choices = [
    { value: 'fixture-one', label: 'Fixture one', icon: IoAddCircleOutline },
    { value: 'fixture-two', label: 'Fixture two', icon: IoPencilOutline },
  ]
  const onChange = vi.fn()
  render(
    <PipelineOptionSelect
      label="Method"
      choices={choices}
      value={choices[0].value}
      onChange={onChange}
    />
  )
  const method = screen.getByRole('button', { name: 'Method' })
  fireEvent.keyDown(method, { key: 'Enter' })
  const menuOptions = screen.getAllByRole('menuitemradio')
  expect(menuOptions.map((option) => option.textContent)).toEqual([
    'Fixture one',
    'Fixture two',
  ])
  expect(
    menuOptions.every(
      (option) =>
        option.querySelector('svg')?.getAttribute('aria-hidden') === 'true'
    )
  ).toBe(true)
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Fixture two' }))
  expect(onChange).toHaveBeenCalledWith(choices[1].value)
})

test('Preview never bootstraps or changes Batch metadata; it uses an existing Batch context', async () => {
  const missing = renderHook(() => usePipelineQueue(), { wrapper })
  await act(async () => {
    await missing.result.current.enqueue([plate], ['tag'], undefined, {}, true)
  })
  expect(mocks.ensure).not.toHaveBeenCalled()
  expect(mocks.api.send).not.toHaveBeenCalled()
  expect(missing.result.current.message).toBe(
    'Preview requires an existing open Batch.'
  )
  missing.unmount()
  const existing = renderHook(() => usePipelineQueue('existing-batch'), {
    wrapper,
  })
  await act(async () => {
    await existing.result.current.enqueue([plate], ['tag'], undefined, {}, true)
  })
  expect(mocks.ensure).not.toHaveBeenCalled()
  expect(mocks.api.send).toHaveBeenCalledWith(
    'POST',
    '/api/local-pipeline/runs/selection',
    expect.objectContaining({ batchId: 'existing-batch', previewOnly: true })
  )
})

test('run cards describe cancelled dependencies and share the real workflow link after deliberate hover', async () => {
  const run = saved({
    status: 'failed',
    stages: ['wiki-link', 'describe', 'story'],
  })
  run.attempts[0] = {
    ...run.attempts[0],
    status: 'failed',
    endedAt: 33100,
    workflowId: 'wrun_real',
    workflowUrl:
      'https://vercel.com/memoriuhl/plate-curator-vercel/workflows/runs/wrun_real?environment=preview',
    steps: [
      {
        index: 0,
        plateId: 'AK.one',
        stage: 'wiki-link',
        resourceClass: 'io',
        status: 'failed',
        startedAt: 100,
        endedAt: 33100,
        reason: 'no_sources',
      },
      {
        index: 1,
        plateId: 'AK.one',
        stage: 'describe',
        resourceClass: 'gpu',
        status: 'cancelled',
        reason: 'upstream_failed',
      },
      {
        index: 2,
        plateId: 'AK.one',
        stage: 'story',
        resourceClass: 'gpu',
        status: 'cancelled',
        reason: 'upstream_failed',
      },
    ],
  }
  render(
    <TooltipProvider>
      <PipelineRunCard
        run={run}
        stages={run.stages}
        progress={queueProgress(run)}
        observedAt={99999}
        requester="Editor"
      />
    </TooltipProvider>
  )
  expect(
    screen.getByRole('button', { name: /Wiki link: Failed/ }).textContent
  ).toBe('Wiki link')
  expect(
    screen.getByRole('button', { name: /Describe: Cancelled/ })
  ).toBeTruthy()
  expect(screen.getByRole('button', { name: /Story: Cancelled/ })).toBeTruthy()
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(screen.queryByText(/Elapsed|00:33/)).toBeNull()
  act(() => screen.getByRole('button', { name: /Describe: Cancelled/ }).focus())
  expect((await screen.findByRole('tooltip')).textContent).toContain(
    'An earlier step failed. This step did not run.'
  )
  const stack = screen.getByRole('button', { name: '1 plate in run aved-run' })
  act(() => stack.focus())
  fireEvent.click(stack)
  expect(screen.queryByRole('dialog')).toBeNull()
  vi.useFakeTimers()
  try {
    fireEvent.pointerEnter(stack, { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(999))
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    const link = screen.getByRole('link', { name: 'Watch this workflow' })
    expect(link.getAttribute('href')).toBe(run.attempts[0].workflowUrl)
    expect(link.getAttribute('target')).toBe('_blank')
  } finally {
    vi.useRealTimers()
  }
})

test('mixed Research results load dashboard plate cards and inspect one plate without changing the grid', async () => {
  const run = saved({
    status: 'completed',
    previewOnly: false,
    stages: ['research'],
    plateIds: ['AK.one', 'AK.two'],
  })
  run.attempts[0] = {
    ...run.attempts[0],
    status: 'completed',
    endedAt: 1000,
    cursor: 2,
    outcome: 'partial',
    steps: [
      {
        index: 0,
        plateId: 'AK.one',
        stage: 'research',
        resourceClass: 'io',
        status: 'completed',
      },
      {
        index: 1,
        plateId: 'AK.two',
        stage: 'research',
        resourceClass: 'io',
        status: 'failed',
        reason: 'stage_failed',
      },
    ],
  }
  run.cards = [
    plate,
    {
      ...plate,
      id: 'AK.two',
      displayName: 'Two',
      imageUrl: 'https://example.org/two.webp',
    },
  ]
  let finish!: (data: { runs: QueueRunView[]; selected: QueueRunView }) => void
  mocks.pathname = `/pipeline/runs/${run.id}`
  mocks.api.get.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  render(
    <>
      <PipelineQueueWarmup />
      <PipelineRunResultsPage runId={run.id} />
    </>,
    { wrapper }
  )
  expect(
    screen
      .getByRole('status', { name: 'Loading run results' })
      .querySelectorAll('li')
  ).toHaveLength(4)
  expect(mocks.api.get).toHaveBeenCalledExactlyOnceWith(
    '/api/local-pipeline/runs?detail=saved-run&detailOnly=1'
  )
  await act(async () => finish({ runs: [run], selected: run }))
  expect(
    await screen.findByText('2 plates · 1 passed · 1 skipped')
  ).toBeTruthy()
  expect(
    screen.queryByRole('status', { name: 'Loading run results' })
  ).toBeNull()
  const grid = screen.getByRole('list', { name: 'Plates in this run' })
  expect(grid.children).toHaveLength(2)
  expect(screen.getByRole('img', { name: 'Two plate' })).toBeTruthy()
  expect(screen.getByText('Passed')).toBeTruthy()
  const changes = screen.getByRole('button', { name: 'View changes for Two' })
  fireEvent.click(changes)
  const dialog = screen.getByRole('dialog', { name: 'Two' })
  expect(dialog.textContent).toContain('The worker could not finish this step.')
  expect(grid.children).toHaveLength(2)
  fireEvent.keyDown(dialog, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(changes)
})

test('the stage eye opens changed plate cards by state inside the drawer and Back restores the run', async () => {
  const two = { ...plate, id: 'CA.two', state: 'CA', displayName: 'Two' }
  const unchanged = {
    ...plate,
    id: 'CA.three',
    state: 'CA',
    displayName: 'Three',
  }
  const cards = [two, unchanged, plate]
  const run = saved({
    status: 'completed',
    plateIds: cards.map((card) => card.id),
    cards,
  })
  run.progress = {
    workerIds: [],
    steps: cards.map((card, index) => ({
      index,
      plateId: card.id,
      plateName: card.displayName,
      stage: 'tag',
      status: 'completed',
    })),
  }
  run.jobs = cards.map((card) => ({
    id: `${card.id}-tag`,
    batchId: run.batchId,
    plateId: card.id,
    requestedBy: run.requestedBy,
    env: run.env,
    inputHash: 'hash',
    state: 'completed',
    createdAt: 100,
    result: {
      suggestions: card === unchanged ? [] : ['blue'],
      backend: 'local',
      model: 'test',
      promptVersion: 'v1',
      durationMs: 1,
    },
  }))
  let finish!: (data: { runs: QueueRunView[]; selected: QueueRunView }) => void
  mocks.api.get.mockImplementation(async (path: string) =>
    path === pipelineRunDetailKey(run.id)
      ? new Promise((resolve) => {
          finish = resolve
        })
      : { runs: [run] }
  )
  render(
    <DashboardPipelineProvider>
      <DashboardPipelineToggle />
      <DashboardPipelineDrawer />
    </DashboardPipelineProvider>,
    { wrapper }
  )
  fireEvent.click(screen.getByRole('button', { name: 'Open Plate Pipeline' }))
  const drawer = within(
    await screen.findByRole('dialog', { name: 'Plate Pipeline' })
  )
  const eye = await drawer.findByRole('button', { name: 'View Tag results' })
  const url = window.location.href
  const runList = drawer.getByRole('region', { name: 'Plate Pipeline runs' })
  const scroller = runList.closest<HTMLElement>('[data-pipeline-scroll]')!
  scroller.scrollTop = 180
  fireEvent.click(eye)

  expect(
    await drawer.findByRole('heading', { name: 'Tag results' })
  ).toBeTruthy()
  expect(
    drawer
      .getByRole('status', { name: 'Loading run results' })
      .querySelectorAll('li')
  ).toHaveLength(4)
  await act(async () => finish({ runs: [run], selected: run }))
  const alaska = await drawer.findByRole('list', { name: 'Alaska' })
  expect(
    drawer.queryByRole('status', { name: 'Loading run results' })
  ).toBeNull()
  const california = drawer.getByRole('list', { name: 'California' })
  expect(within(alaska).getByRole('heading', { name: 'One' })).toBeTruthy()
  expect(within(california).getByRole('heading', { name: 'Two' })).toBeTruthy()
  expect(california.children).toHaveLength(1)
  expect(
    drawer.queryByRole('region', { name: 'Plate Pipeline runs' })
  ).toBeNull()
  expect(window.location.href).toBe(url)

  fireEvent.click(drawer.getByRole('button', { name: 'Back to runs' }))
  expect(drawer.getByRole('button', { name: 'View Tag results' })).toBe(eye)
  expect(document.activeElement).toBe(eye)
  expect(scroller.scrollTop).toBe(180)
})

test.each([
  {
    progress: { workflowUrl: 'http://localhost:3456/run/wrun_exact' },
    label: 'Show workflow run',
  },
  {
    progress: {
      workflowUrl: 'https://vercel.com/team/project/workflows/runs/wrun_exact',
    },
    label: 'Show Vercel workflow run',
  },
  {
    progress: { gatewayUrl: 'https://vercel.com/team/~/ai-gateway/logs' },
    label: 'Show Vercel AI Gateway logs',
  },
])(
  'the run number opens the inspector labeled $label',
  async ({ progress, label }) => {
    const run = { ...saved(), batchName: 'Florida pipeline' }
    render(
      <TooltipProvider>
        <PipelineRunCard
          run={run}
          progress={{ ...queueProgress(run), ...progress }}
          stages={run.stages}
        />
      </TooltipProvider>
    )
    const runLink = screen.getByRole('link', { name: 'Run saved-run' })
    expect(runLink.getAttribute('href')).toBe(
      progress.workflowUrl ?? progress.gatewayUrl
    )
    expect(runLink.getAttribute('target')).toBe('_blank')
    expect(screen.queryByText('Florida pipeline')).toBeNull()
    fireEvent.focus(runLink)
    expect((await screen.findByRole('tooltip')).textContent).toBe(label)
  }
)

/** A hosted run as `GET /api/jobs/runs` lists it. */
function gatewayRun(status: QueueRunView['status']) {
  return {
    id: 'gateway-run',
    batchId: 'batch',
    requestedBy: 'editor',
    plateIds: ['AK.one'],
    modelId: 'gateway-gemma4-26b',
    createdAt: 100,
    status,
    progress: { workerIds: [], steps: [], workflowUrl: null },
    results: [],
  }
}

test.each([
  {
    queue: 'completed',
    gateway: 'completed',
    queueMs: 600_000,
    gatewayMs: 600_000,
  },
  { queue: 'queued', gateway: 'failed', queueMs: 60_000, gatewayMs: 600_000 },
  {
    queue: 'cancelled',
    gateway: 'running',
    queueMs: 600_000,
    gatewayMs: 60_000,
  },
] as const)(
  'while live, a drawer list with no active run stretches its safety refresh to ten minutes (queue $queue, Gateway $gateway)',
  async ({ queue, gateway, queueMs, gatewayMs }) => {
    mocks.api.get.mockImplementation(async (path: string) =>
      path.startsWith('/api/local-pipeline')
        ? { runs: [saved({ status: queue })], observedAt: 1 }
        : { runs: [gatewayRun(gateway)], observedAt: 1 }
    )
    function Runs() {
      return <PipelineRuns queue={usePipelineQueue()} />
    }
    render(<Runs />, { wrapper })
    await screen.findByRole('article', { name: 'Pipeline run saved-run' })
    await waitFor(() => {
      expect(mocks.safety.get('/api/local-pipeline/runs?detail=none')).toBe(
        queueMs
      )
      expect(mocks.safety.get('/api/jobs/runs')).toBe(gatewayMs)
    })
  }
)

test('an open run keeps a one-minute safety refresh while it is active, and ten minutes once it ends', async () => {
  let status: QueueRunView['status'] = 'running'
  mocks.api.get.mockImplementation(async () => ({
    runs: [saved({ status })],
    selected: saved({ status }),
    observedAt: status === 'running' ? 1 : 2,
  }))
  const { result } = renderHook(
    () => usePipelineQueue(undefined, undefined, 'saved-run'),
    { wrapper }
  )
  await waitFor(() => expect(result.current.selected?.status).toBe('running'))
  expect(mocks.safety.get(pipelineRunDetailKey('saved-run'))).toBe(60_000)
  status = 'completed'
  await act(async () => {
    await result.current.refresh()
  })
  await waitFor(() =>
    expect(mocks.safety.get(pipelineRunDetailKey('saved-run'))).toBe(600_000)
  )
})

test('History stays with the title and All Machines remains selected when only one machine has runs', async () => {
  mocks.api.get.mockImplementation(async (path: string) =>
    path.startsWith('/api/local-pipeline') ? { runs: [saved()] } : { runs: [] }
  )
  function Runs() {
    return <PipelineRuns queue={usePipelineQueue()} />
  }
  render(<Runs />, { wrapper })
  await screen.findByRole('article', { name: 'Pipeline run saved-run' })
  const heading = screen.getByRole('heading', { name: 'Plate Pipeline' })
  const header = heading.closest('header')!
  expect(
    within(heading.parentElement!).getByRole('button', { name: 'History' })
  ).toBeTruthy()
  const rail = screen.getByRole('region', {
    name: 'Plate Pipeline runs, scroll horizontally',
  })
  expect(within(rail).queryByRole('button', { name: 'History' })).toBeNull()
  fireEvent.keyDown(
    within(header).getByRole('button', { name: 'View runs: All Machines' }),
    { key: 'Enter' }
  )
  expect(
    (
      await screen.findByRole('menuitemradio', { name: 'All Machines' })
    ).getAttribute('aria-checked')
  ).toBe('true')
  expect(
    screen
      .getByRole('menuitemradio', { name: 'Vercel Gateway' })
      .hasAttribute('data-disabled')
  ).toBe(true)
})

test('All Machines shows full runs once and filters by their recorded devices', async () => {
  const plateIds = ['AK.one', 'AK.two', 'AK.three', 'AK.four', 'AK.five']
  const local = saved({
    batchName: 'Alabama pipeline',
    plateIds,
    stages: ['research', 'tag'],
    tagModelId: 'desktop-gemma4-12b',
    researchModel: {
      id: 'eve-gemini-2-5-flash-lite',
      executor: 'eve',
      model: 'google/gemini-2.5-flash-lite',
    },
  })
  const desktop = saved({ id: 'enhance', stages: ['enhance-image'] })
  const gateway = {
    id: 'gateway-run',
    batchId: 'batch',
    requestedBy: 'editor',
    plateIds: ['AK.one'],
    modelId: 'gateway-gemma4-26b',
    createdAt: 100,
    status: 'completed',
    progress: {
      workerIds: [],
      endedAt: 800,
      steps: [
        {
          index: 0,
          plateId: 'AK.one',
          plateName: 'One',
          stage: 'tag',
          status: 'completed',
          durationMs: 700,
        },
      ],
      workflowUrl: null,
    },
    results: [],
  }
  mocks.api.get.mockImplementation(async (path: string) =>
    path.startsWith('/api/local-pipeline')
      ? { runs: [local, desktop], observedAt: 1000 }
      : { runs: [gateway, { ...gateway, id: local.id }], observedAt: 10_000 }
  )
  /**
   * Connect the real queue hook to the panel so the test can observe resumed run
   * details.
   */
  function Runs() {
    return <PipelineRuns queue={usePipelineQueue()} stacked />
  }
  render(<Runs />, { wrapper })
  const combined = await screen.findByRole('article', {
    name: 'Pipeline run saved-run',
  })
  expect(
    within(combined).getByRole('button', {
      name: /Alabama pipeline.*5 plates.*Vercel Gateway.*Gemini 2.5 Flash Lite.*Local PC.*Gemma 4 12B/,
    })
  ).toBeTruthy()
  expect(
    within(
      await screen.findByRole('article', { name: 'Pipeline run gateway-run' })
    ).getByRole('button', { name: /Vercel Gateway.*Gemma 4 26B/ })
  ).toBeTruthy()
  expect(
    screen.getAllByRole('article', { name: 'Pipeline run saved-run' })
  ).toHaveLength(1)

  async function select(from: string, to: string) {
    fireEvent.keyDown(
      screen.getByRole('button', { name: `View runs: ${from}` }),
      { key: 'Enter' }
    )
    fireEvent.click(await screen.findByRole('menuitemradio', { name: to }))
  }
  await select('All Machines', 'Local PC')
  expect(
    screen.queryByRole('article', { name: 'Pipeline run gateway-run' })
  ).toBeNull()
  expect(
    screen.getByRole('article', { name: 'Pipeline run enhance' })
  ).toBeTruthy()
  await select('Local PC', 'Vercel Gateway')
  expect(
    screen.getByRole('article', { name: 'Pipeline run saved-run' })
  ).toBeTruthy()
  expect(
    screen.getByRole('article', { name: 'Pipeline run gateway-run' })
  ).toBeTruthy()
  expect(
    screen.queryByRole('article', { name: 'Pipeline run enhance' })
  ).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'History' }))
  expect(screen.getByRole('link', { name: 'Run eway-run' })).toBeTruthy()
  expect(mocks.api.send).not.toHaveBeenCalled()
})

test('coherent facts and read-more links use readable text and cited links instead of raw JSON', () => {
  expect(pipelineFieldLabel('funFacts')).toBe('Fun facts')
  expect(pipelineFieldLabel('firstIssuedYear')).toBe('First issued')
  render(
    <>
      <PipelineFieldValue
        field="funFacts"
        value={[
          {
            text: 'This design was first issued in 1976.',
            sourceUrl: 'https://example.org/fact',
            sourceTitle: 'Issuing authority',
          },
        ]}
      />
      <PipelineFieldValue
        field="readMore"
        value={[
          {
            title: 'Design history',
            site: 'Museum',
            url: 'https://example.org/history',
          },
        ]}
      />
      <PipelineFieldValue field="tags" value={['blue', 'graphic']} />
    </>
  )
  expect(screen.getByText('This design was first issued in 1976.')).toBeTruthy()
  expect(
    screen.getByRole('link', { name: 'Issuing authority' }).getAttribute('href')
  ).toBe('https://example.org/fact')
  expect(
    screen.getByRole('link', { name: 'Design history' }).getAttribute('href')
  ).toBe('https://example.org/history')
  expect(screen.getByText('Museum')).toBeTruthy()
  expect(screen.queryByText(/"sourceUrl"/)).toBeNull()
})

test('incremental History links to saved changes and preserves visibility of a conflicting stage', () => {
  const run = saved({
    id: 'run-chunk',
    dismissedAt: 300,
    batchId: 'pipeline-draft',
    batchName: 'Coastal Batch',
    status: 'failed',
    incrementalDrafts: true,
    previewOnly: false,
    draftPlateIds: ['AK.one'],
  })
  run.attempts[0].steps[0] = {
    ...run.attempts[0].steps[0],
    status: 'failed',
    reason: 'draft_conflict',
  }
  const controls = {
    runs: [run],
    loading: false,
    error: null,
    refresh: vi.fn(),
    action: null,
    message: '',
    cancel: vi.fn(),
    dismiss: vi.fn(),
    retry: vi.fn(),
  }
  render(
    <>
      <PipelineQueuePanel queue={controls} />
      <PipelineRunResults run={run} actions={resultActions} />
    </>
  )
  expect(screen.getByText(/1 saved to Coastal Batch/)).toBeTruthy()
  fireEvent.click(
    screen.getByRole('button', { name: 'View changes for AK.one' })
  )
  expect(screen.getByRole('alert').textContent).toContain(
    'Your edits were kept'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Close plate changes' }))
  expect(
    screen.queryByRole('button', { name: 'Apply coherent run to your Batch' })
  ).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'History' }))
  const resultsUrl = '/pipeline/runs/run-chunk?batch=pipeline-draft'
  const history = screen.getByRole('link', { name: 'Run un-chunk' })
  expect(history.getAttribute('href')).toBe(resultsUrl)
  fireEvent.click(history.closest('summary')!)
  expect(
    screen
      .getByRole('link', { name: 'View saved results' })
      .getAttribute('href')
  ).toBe(resultsUrl)
})

test('saved research shows the job result even after the queue projection matches the draft', () => {
  const sourceUrl = 'https://example.org/plate-history'
  const fields = {
    description: 'Description from the issuing authority.',
    funFacts: [
      {
        text: 'The plate debuted in 1976.',
        sourceUrl,
        sourceTitle: 'Issuing authority',
      },
    ],
  }
  const draft = {
    id: plate.id,
    state: plate.state,
    displayName: plate.displayName,
    tags: plate.tags,
    slug: 'one',
    image: '',
    ...fields,
  }
  const run = saved({
    stages: ['research'],
    status: 'completed',
    incrementalDrafts: true,
    previewOnly: false,
    draftPlateIds: [plate.id],
  })
  run.attempts[0].projection = {
    baselineVersion: 1,
    plates: {
      [plate.id]: {
        batchInput: draft,
        executionPlate: draft,
        batchInputHash: 'saved',
        executionHash: 'saved',
        sourceJobIds: ['research-job'],
      },
    },
  }
  run.jobs = [
    {
      id: 'research-job',
      batchId: run.batchId,
      plateId: plate.id,
      requestedBy: run.requestedBy,
      env: run.env,
      inputHash: 'initial',
      state: 'completed',
      createdAt: 100,
      stage: 'research',
      result: {
        suggestions: [],
        fieldSuggestion: {
          kind: 'fields',
          stage: 'research',
          fields,
          sources: [sourceUrl],
        },
        backend: 'eve',
        model: 'fixture',
        promptVersion: 'v1',
        durationMs: 50,
      },
    },
  ]
  render(<PipelineRunResults run={run} actions={resultActions} />)
  fireEvent.click(screen.getByRole('button', { name: 'View changes for One' }))
  expect(screen.getByText(fields.description)).toBeTruthy()
  expect(screen.getByText(fields.funFacts[0].text)).toBeTruthy()
  expect(
    screen.getByRole('link', { name: 'Issuing authority' }).getAttribute('href')
  ).toBe(sourceUrl)
  fireEvent.click(screen.getByRole('button', { name: 'Close plate changes' }))
  expect(
    screen
      .getByRole('link', { name: 'Review run changes' })
      .getAttribute('href')
  ).toBe('/review?batch=batch&run=saved-run')
})

test('the form enforces 200 selected plates', async () => {
  const enqueue = vi.fn().mockResolvedValue(saved())
  const plates = Array.from({ length: 201 }, (_, index) => ({
    ...plate,
    id: `MD.${index}`,
    state: 'MD',
  }))
  plateSelection.replace(plates)
  const capabilities = {
    ...imageGroupCapabilities({
      embeddings: true,
      backgroundMask: false,
      visionTiebreak: false,
    }),
    reportedAt: 100,
    pollIntervalMs: 1000,
  }
  render(
    <PipelineRunControls
      batchPlates={[]}
      stateName="Maryland"
      queue={{
        runs: [],
        action: null,
        message: '',
        disabledReason: undefined,
        enqueue,
        capabilities,
      }}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Tag' }))
  const start = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Start Run',
  })
  expect(start.disabled).toBe(true)
  expect(screen.getByRole('alert').textContent).toBe('Up to 200 plates per run')
  const allowed = plates.slice(0, 200)
  act(() => plateSelection.replace(allowed))
  fireEvent.click(start)
  await waitFor(() => expect(enqueue.mock.calls[0]?.[0]).toEqual(allowed))
})

test('Enhance image toggles independently and queues without a model', async () => {
  const enqueue = vi.fn().mockResolvedValue(saved())
  const capabilities = {
    ...imageGroupCapabilities(),
    'enhance-image': { available: true },
    reportedAt: 100,
    pollIntervalMs: 1000,
  }
  render(
    <PipelineRunControls
      batchPlates={[]}
      stateName="Alaska"
      queue={{
        runs: [],
        action: null,
        message: '',
        disabledReason: undefined,
        enqueue,
        capabilities,
      }}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Enhance image' }))
  fireEvent.click(
    screen.getByRole('button', { name: 'More options for Enhance image' })
  )
  fireEvent.click(screen.getByRole('checkbox', { name: 'Upscale' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Crop margins' }))
  const start = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Start Run',
  })
  expect(start.disabled).toBe(true)
  expect(
    document.getElementById(start.getAttribute('aria-describedby') ?? '')
      ?.textContent
  ).toContain('Choose at least one enhancement.')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Round corners' }))
  fireEvent.click(screen.getByRole('button', { name: 'Start Run' }))
  await waitFor(() =>
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      [plate],
      ['enhance-image'],
      undefined,
      { 'enhance-image': { upscale: false, crop: false, roundCorners: true } },
      false,
      undefined,
      undefined,
      'Alaska pipeline'
    )
  )
})

test('enhancement-only results offer a preview and download from the completed job', async () => {
  const run = saved({
    status: 'completed',
    stages: ['enhance-image'],
    previewOnly: false,
    incrementalDrafts: true,
  })
  run.jobs = [
    {
      id: 'enhanced-one',
      batchId: 'batch',
      plateId: plate.id,
      requestedBy: 'editor',
      env: run.env,
      inputHash: 'hash',
      state: 'completed',
      createdAt: 100,
      result: {
        suggestions: [],
        fieldSuggestion: {
          kind: 'enhanced-image',
          stage: 'enhance-image',
          width: 640,
          height: 320,
          originalWidth: 320,
          originalHeight: 160,
          sha256: 'a'.repeat(64),
        },
        backend: 'local',
        model: 'sharp',
        promptVersion: 'enhance-image-v1',
        durationMs: 4,
      },
    },
  ]
  mocks.api.get.mockResolvedValue({ image: 'AQIDBA==' })
  render(<PipelineRunResults run={run} actions={resultActions} />)
  fireEvent.click(
    screen.getByRole('button', { name: 'View changes for AK.one' })
  )
  fireEvent.click(
    screen.getByRole('button', { name: 'Preview enhanced image' })
  )
  const link = await screen.findByRole('link', { name: 'Download WebP' })
  expect(link.getAttribute('href')).toBe('data:image/webp;base64,AQIDBA==')
  expect(mocks.api.get).toHaveBeenCalledExactlyOnceWith(
    '/api/local-pipeline/jobs/enhanced-one/enhanced-image'
  )
})

test('a stage result shows the selected stage and keeps a link back to all results', async () => {
  const run = saved({
    status: 'completed',
    stages: ['enhance-image', 'tag'],
    plateIds: [plate.id, 'AK.two'],
  })
  run.progress = {
    workerIds: [],
    steps: [
      {
        index: 0,
        plateId: plate.id,
        plateName: 'One',
        stage: 'enhance-image',
        status: 'completed',
      },
      {
        index: 1,
        plateId: 'AK.two',
        plateName: 'Two',
        stage: 'tag',
        status: 'completed',
      },
    ],
  }
  run.jobs = [
    {
      id: 'enhanced-one',
      batchId: 'batch',
      plateId: plate.id,
      requestedBy: 'editor',
      env: run.env,
      inputHash: 'hash',
      state: 'completed',
      stage: 'enhance-image',
      createdAt: 100,
      result: {
        suggestions: [],
        fieldSuggestion: {
          kind: 'enhanced-image',
          stage: 'enhance-image',
          width: 640,
          height: 320,
          originalWidth: 320,
          originalHeight: 160,
          sha256: 'a'.repeat(64),
        },
        backend: 'local',
        model: 'sharp',
        promptVersion: 'enhance-image-v1',
        durationMs: 4,
      },
    },
  ]
  mocks.api.get.mockResolvedValue({ runs: [run], selected: run })
  render(<PipelineRunResultsPage runId={run.id} stage="enhance-image" />, {
    wrapper,
  })
  expect(
    await screen.findByRole('heading', { name: 'Enhance image results' })
  ).toBeTruthy()
  expect(
    screen.getByRole('link', { name: 'All run results' }).getAttribute('href')
  ).toBe('/pipeline/runs/saved-run?batch=batch')
  expect(
    screen.getByRole('list', { name: 'Plates in this run' }).children
  ).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'View changes for One' }))
  expect(
    screen.getByRole('button', { name: 'Preview enhanced image' })
  ).toBeTruthy()
})

test('the dashboard hover opens the latest final frame and can preview a previous operation', async () => {
  const hash = 'a'.repeat(64)
  const frames = (['original', 'crop', 'upscale', 'roundCorners'] as const).map(
    (step) => ({ step, width: 160, height: 80, sha256: hash })
  )
  mocks.api.get.mockImplementation(async (path: string) =>
    path.endsWith('/enhancement')
      ? {
          result: {
            jobId: 'latest',
            suggestion: {
              kind: 'enhanced-image',
              stage: 'enhance-image',
              width: 160,
              height: 80,
              originalWidth: 160,
              originalHeight: 80,
              sha256: hash,
              frames,
            },
          },
        }
      : { image: 'AQIDBA==' }
  )
  render(
    <PlateEnhancementPreview plateId={plate.id} plateName="One">
      <span>Original image</span>
    </PlateEnhancementPreview>,
    { wrapper }
  )
  expect(
    await screen.findByRole('img', { name: 'Round corners preview of One' })
  ).toBeTruthy()
  fireEvent.pointerEnter(screen.getByRole('button', { name: 'Crop margins' }))
  expect(
    await screen.findByRole('img', { name: 'Crop margins preview of One' })
  ).toBeTruthy()
  expect(mocks.api.get).toHaveBeenCalledWith(
    '/api/local-pipeline/jobs/latest/enhanced-image?step=crop'
  )
  fireEvent.pointerLeave(
    screen.getByRole('group', { name: 'Image preview steps' })
  )
  expect(
    await screen.findByRole('img', { name: 'Round corners preview of One' })
  ).toBeTruthy()
})

test('worker phases advance the active box for just that plate', () => {
  const steps = [
    {
      index: 0,
      plateId: plate.id,
      plateName: 'One',
      stage: 'research' as const,
      status: 'running' as const,
      phaseIndex: 1,
    },
    {
      index: 1,
      plateId: 'AK.two',
      plateName: 'Two',
      stage: 'enhance-image' as const,
      status: 'queued' as const,
    },
  ]
  const images = { [plate.id]: 'https://example.org/one.webp' }
  const { rerender } = render(
    <PlatePipelineTimeline steps={steps} batchId="batch" images={images} />
  )
  const preview = screen.getByRole('button', { name: 'Preview One plate' })
  fireEvent.focus(preview)
  const tooltip = screen.getByRole('tooltip')
  expect(tooltip.querySelector('img')?.getAttribute('src')).toBe(
    images[plate.id]
  )
  expect(
    screen
      .getByRole('link', { name: 'Go to One on the dashboard' })
      .getAttribute('href')
  ).toBe('/states/AK?plate=AK.one&batch=batch#families')
  fireEvent.blur(preview)
  const first = screen.getByRole('list', { name: 'One pipeline steps' })
  const header = first.previousElementSibling!
  expect(header.tagName).toBe('HEADER')
  expect(header.firstElementChild).toBe(preview)
  expect(header.children[1]?.textContent).toBe('One')
  expect(header.lastElementChild).toBe(
    screen.getByRole('link', { name: 'Go to One on the dashboard' })
  )
  const second = screen.getByRole('list', { name: 'Two pipeline steps' })
  expect(first.querySelector('[aria-current="step"]')?.textContent).toContain(
    'Draft description & story'
  )
  expect(second.querySelectorAll('[data-status="queued"]')).toHaveLength(2)
  rerender(
    <PlatePipelineTimeline steps={[{ ...steps[0], phaseIndex: 2 }, steps[1]]} />
  )
  expect(first.querySelector('[aria-current="step"]')?.textContent).toContain(
    'Validate result'
  )
  expect(first.querySelectorAll('[data-status="completed"]')).toHaveLength(2)
  rerender(
    <PlatePipelineTimeline
      steps={[
        { ...steps[0], status: 'completed', skippedPhases: [0] },
        steps[1],
      ]}
    />
  )
  expect(first.querySelector('[data-status="skipped"]')?.textContent).toContain(
    'Find sources Skipped'
  )
  expect(first.querySelectorAll('[data-status="completed"]')).toHaveLength(2)
  expect(second.querySelector('[data-status="skipped"]')).toBeNull()
})

test('the pipeline estimate follows the chosen model and sums only planned plates', async () => {
  mocks.api.get.mockResolvedValue({
    [runTimingKey('tag', 'desktop', 'gemma4:12b')]: 40_000,
    [runTimingKey('tag', 'gateway', 'google/gemma-4-26b-a4b-it')]: 8_000,
  })
  const plates = [
    plate,
    { ...plate, id: 'AK.two', tags: ['blue', 'red', 'white'] },
  ]
  plateSelection.replace(plates)
  const queue = {
    runs: [],
    action: null,
    message: '',
    disabledReason: undefined,
    enqueue: vi.fn(),
  }
  const controls = () => (
    <PipelineRunControls
      batchPlates={plates}
      stateName="Alaska"
      queue={queue}
    />
  )
  const view = render(controls(), { wrapper })
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  expect(screen.queryByText(/processing time/)).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Tag' }))
  expect(await screen.findByText('EST 00:40 / plate')).toBeTruthy()
  expect(screen.getByText('EST 01:20 processing time')).toBeTruthy()

  mocks.modelId = 'gateway-gemma4-26b'
  view.rerender(controls())
  expect(screen.getByText('EST 00:08 / plate')).toBeTruthy()
  expect(screen.getByText('EST 00:08 processing time')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'More options for Tag' }))
  fireEvent.click(
    screen.getByRole('checkbox', { name: /Only under-tagged plates/ })
  )
  expect(screen.getByText('EST 00:08 processing time')).toBeTruthy()
})

test('the single-stage run menu uses the selected Gateway model history', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '0')
  mocks.modelId = 'gateway-gemma4-26b'
  mocks.api.get.mockResolvedValue({
    [runTimingKey('tag', 'gateway', 'google/gemma-4-26b-a4b-it')]: 13_000,
  })
  render(
    <RunMenu
      underTagged={[plate]}
      batchPlates={[]}
      stateName="Alaska"
      disabled={false}
      start={vi.fn()}
    />,
    { wrapper }
  )
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  expect(await screen.findByText('EST 00:13 / plate')).toBeTruthy()
  expect(screen.getByText(/EST 00:13 processing time/)).toBeTruthy()
})

test('the run menu shows each stage result rule and opens from the selection bar', () => {
  render(
    <>
      <PipelineRunControls
        batchPlates={[plate]}
        stateName="Alaska"
        queue={{
          runs: [],
          action: null,
          message: '',
          disabledReason: undefined,
          enqueue: vi.fn(),
        }}
      />
      <SelectionBar />
    </>
  )
  expect(screen.queryByRole('group', { name: 'Pipeline stages' })).toBeNull()
  fireEvent.click(
    screen.getByRole('button', { name: 'Run pipeline on 1 plate' })
  )
  const rules = Object.fromEntries(
    [...document.querySelectorAll('[data-result-rule]')].map((node) => [
      node.closest('label')?.querySelector('input')?.getAttribute('aria-label'),
      node.textContent,
    ])
  )
  expect(rules).toEqual({
    'Research / enrich': 'Saved automatically',
    'Find image': 'Waits for you to choose a candidate',
    'Enhance image': 'Waits until you click Apply',
    Tag: 'Saved automatically; Review is optional',
    Group: 'Waits for you to verify the proposed families',
  })
})

test('work-in-progress stages are greyed out while real unavailability stays red', () => {
  render(
    <PipelineRunControls
      batchPlates={[plate]}
      stateName="Alaska"
      queue={{
        runs: [],
        action: null,
        message: '',
        disabledReason: undefined,
        enqueue: vi.fn(),
      }}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  const row = (name: string) =>
    screen.getByRole('checkbox', { name }).closest('[class*="border"]')!
  for (const name of ['Find image', 'Group']) {
    const badge = row(name).querySelector('[data-tone]')!
    expect(badge.getAttribute('data-tone')).toBe('muted')
    expect(badge.textContent).toMatch(/^Work in progress/)
    expect(badge.querySelector('svg')).toBeNull()
    expect(badge.className).not.toContain('danger')
    expect(row(name).hasAttribute('data-work-in-progress')).toBe(true)
    expect(row(name).className).toContain('opacity-60')
  }
  const real = row('Enhance image')
  const badge = real.querySelector('[data-tone]')!
  expect(badge.getAttribute('data-tone')).toBe('danger')
  expect(badge.textContent).toBe('Local worker not reporting')
  expect(badge.querySelector('svg')).not.toBeNull()
  expect(real.hasAttribute('data-work-in-progress')).toBe(false)
})
