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
import type { ReactNode } from 'react'
import {
  PipelineQueueWarmup,
  usePipelineQueue,
} from '../../components/dashboard/use-pipeline-queue'
import { PipelineQueuePanel } from '../../components/dashboard/pipeline-queue-panel'
import {
  PipelineRunResults,
  PipelineRunResultsPage,
} from '../../components/dashboard/pipeline-run-results'
import type { QueueRunView } from '../../lib/jobs/queue-types'
import { PipelineRunControls } from '../../components/dashboard/pipeline-run-controls'
import { RunMenu } from '../../components/dashboard/run-menu'
import { runTimingKey } from '../../lib/jobs/run-timings'
import { PipelineOptionSelect } from '../../components/dashboard/pipeline-option-select'
import { TAGGING_MODELS } from '../../lib/tagging/models'
import {
  PipelineFieldValue,
  pipelineFieldLabel,
} from '../../components/dashboard/pipeline-field-value'
import { imageGroupCapabilities } from '../../lib/jobs/image-options'
import { PlateEnhancementPreview } from '../../components/plate/plate-image-preview'
import { PlatePipelineTimeline } from '../../components/dashboard/plate-pipeline-timeline'
import { PipelineRunCard } from '../../components/dashboard/pipeline-run-card'
import { PipelineRuns } from '../../components/dashboard/pipeline-runs'
import { queueProgress } from '../../lib/jobs/run-progress'
import {
  plateSelection,
  SelectionPresence,
} from '../../components/dashboard/plate-selection'
import { plateCards } from '../../fixtures/plate-cards'
import type { PlateCardData } from '../../lib/catalog/dashboard-types'
import { RESEARCH_MODELS } from '../../lib/research/models'

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), send: vi.fn() },
  ensure: vi.fn(),
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
  useMe: () => ({ data: { uid: 'editor', name: 'Editor' } }),
}))

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
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
  mocks.ensure.mockReset().mockResolvedValue('batch')
  plateSelection.replace([plate])
  mocks.models = [...TAGGING_MODELS]
  mocks.modelId = 'desktop-gemma4-12b'
  mocks.api.get
    .mockReset()
    .mockResolvedValue({ runs: [saved()], selected: saved() })
  mocks.api.send.mockReset().mockResolvedValue({ run: saved() })
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
  let summaryRequests = 0
  mocks.api.get.mockImplementation((path: string) => {
    if (path.endsWith('detail=saved-run'))
      return Promise.resolve({
        runs: [updated],
        selected: updated,
        observedAt: 200,
      })
    return ++summaryRequests === 1
      ? Promise.resolve({ runs: [initial], observedAt: 100 })
      : new Promise(() => {})
  })
  function QueueSnapshot({ detail }: { detail?: string }) {
    const queue = usePipelineQueue(undefined, undefined, detail)
    return <div>{queue.runs[0]?.status ?? 'empty'}</div>
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
})

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

test('each card toggles its own live plate steps and starts collapsed', () => {
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
  const active = within(
    screen.getByRole('article', { name: 'Pipeline run running' })
  )
  const other = within(
    screen.getByRole('article', { name: 'Pipeline run queued' })
  )
  const chevron = active.getByRole('button', { name: 'Watch steps' })
  const panel = () =>
    document.getElementById(chevron.getAttribute('aria-controls') ?? '')
  expect(chevron.getAttribute('aria-expanded')).toBe('false')
  expect(panel()?.hidden).toBe(true)
  expect(
    active.queryByRole('region', { name: 'Pipeline steps by plate' })
  ).toBeNull()
  fireEvent.click(chevron)
  expect(
    active.getByRole('region', { name: 'Pipeline steps by plate' })
  ).toBeTruthy()
  expect(
    other.queryByRole('region', { name: 'Pipeline steps by plate' })
  ).toBeNull()
  expect(chevron.getAttribute('aria-expanded')).toBe('true')
  expect(panel()?.hidden).toBe(false)
  view.rerender(
    <PipelineQueuePanel
      queue={{ ...queue, runs: [{ ...running, status: 'completed' }, queued] }}
    />
  )
  expect(
    active.getByRole('region', { name: 'Pipeline steps by plate' })
  ).toBeTruthy()
  fireEvent.click(active.getByRole('button', { name: 'Hide steps' }))
  expect(
    active.queryByRole('region', { name: 'Pipeline steps by plate' })
  ).toBeNull()
})

test('the requester is in the header and run details sit beside the stages', async () => {
  const run = saved({
    status: 'running',
    requestedByName: 'Morgan',
    stages: ['enhance-image', 'tag'],
  })
  run.progress = {
    workerIds: [],
    startedAt: 200,
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
  const controls = within(
    within(card).getByRole('group', { name: 'Run details' })
  )
  const activity = controls.getByRole('button', { name: 'Run activity' })
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
  expect(controls.getByRole('button', { name: 'Watch steps' })).toBeTruthy()
  expect(within(card.querySelector('footer')!).queryByRole('button')).toBeNull()
  expect(within(card.querySelector('footer')!).queryByRole('link')).toBeNull()
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

test('the combined Research control enqueues its selected hosted model and policy once', async () => {
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
  const hosted = screen.getByRole('menuitemradio', { name: /Hosted research/ })
  expect(
    screen.getByRole('dialog', { name: 'Run pipeline' }).contains(hosted)
  ).toBe(true)
  fireEvent.click(hosted)
  expect(picker.textContent).toContain('Hosted research (Eve)')
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
        researchModelId: RESEARCH_MODELS[2].id,
      }
    )
  )
})

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
  fireEvent.click(screen.getByRole('checkbox', { name: 'Reuse saved sources' }))
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

test('worker capabilities enable Group and normalize unsupported default colour signal OFF; Preview ignores standalone capability', async () => {
  const enqueue = vi.fn().mockResolvedValue(saved())
  const capabilities = {
    ...imageGroupCapabilities({
      embeddings: true,
      backgroundMask: false,
      visionTiebreak: false,
      maskReason: 'Mask unavailable',
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
  fireEvent.click(screen.getByRole('checkbox', { name: 'Group' }))
  fireEvent.click(
    screen.getByRole('button', { name: 'More options for Group' })
  )
  expect(screen.getByText('Method · Embeddings')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Method' })).toBeNull()
  expect(screen.getByText(/Use colour signal ·/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Start Run' }))
  await waitFor(() =>
    expect(enqueue).toHaveBeenCalledWith(
      [plate],
      ['group'],
      undefined,
      {
        group: {
          method: 'embeddings',
          colorSignal: false,
          backgroundMask: false,
          visionTiebreak: false,
        },
      },
      false,
      undefined,
      undefined,
      'Alaska pipeline'
    )
  )
})

test('Group explains an unavailable method and cannot queue after the worker loses it', () => {
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
  const queue = {
    runs: [],
    action: null,
    message: '',
    disabledReason: undefined,
    enqueue,
    capabilities,
  }
  const view = (capabilities: typeof queue.capabilities) => (
    <PipelineRunControls
      batchPlates={[plate]}
      stateName="Alaska"
      queue={{ ...queue, capabilities }}
    />
  )
  const result = render(view(capabilities))
  fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Group' }))

  result.rerender(
    view({
      ...capabilities,
      embeddings: { available: false, reason: 'Embedding model offline' },
    })
  )
  expect(screen.getAllByText('Embedding model offline')).toHaveLength(2)
  expect(screen.queryByRole('combobox', { name: 'Method' })).toBeNull()
  const group = screen.getByRole<HTMLInputElement>('checkbox', {
    name: 'Group',
  })
  expect(group.checked).toBe(true)
  const start = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Start Run',
  })
  expect(start.disabled).toBe(true)
  fireEvent.click(start)
  expect(enqueue).not.toHaveBeenCalled()
  fireEvent.click(group)
  expect(group.disabled).toBe(false)
  expect(start.disabled).toBe(true)
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
  mocks.api.get.mockResolvedValue({ runs: [run], selected: run })
  render(<PipelineRunResultsPage runId={run.id} />, { wrapper })
  expect(
    await screen.findByText('2 plates · 1 passed · 1 skipped')
  ).toBeTruthy()
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

test('History sits with the title and device stays static while the other device has no runs', async () => {
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
  expect(within(header).getByText('Local PC')).toBeTruthy()
  expect(within(header).queryByRole('button', { name: /View runs/ })).toBeNull()
  const rail = screen.getByRole('region', {
    name: 'Plate Pipeline runs, scroll horizontally',
  })
  expect(within(rail).queryByRole('button', { name: 'History' })).toBeNull()
})

test('execution dropdown switches local and gateway views without mutating or restarting runs', async () => {
  const local = saved()
  local.progress = {
    ...queueProgress(local),
    workerIds: ['Studio PC', 'Laptop'],
  }
  mocks.api.get.mockImplementation(async (path: string) =>
    path.startsWith('/api/local-pipeline')
      ? { runs: [local], observedAt: 1000 }
      : {
          runs: [
            {
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
            },
          ],
          observedAt: 10_000,
        }
  )
  /**
   * Connect the real queue hook to the panel so the test can observe resumed run
   * details.
   */
  function Runs() {
    return <PipelineRuns queue={usePipelineQueue()} />
  }
  render(<Runs />, { wrapper })
  await waitFor(() =>
    expect(
      screen.getByRole('article', { name: 'Pipeline run saved-run' })
    ).toBeTruthy()
  )
  fireEvent.keyDown(
    await screen.findByRole('button', { name: /View runs: Local PC/ }),
    { key: 'Enter' }
  )
  await waitFor(() =>
    expect(screen.getByRole('menuitemradio', { name: 'Local PC' })).toBeTruthy()
  )
  expect(screen.queryByText('Studio PC')).toBeNull()
  fireEvent.click(screen.getByRole('menuitemradio', { name: /Vercel Gateway/ }))
  await waitFor(() =>
    expect(
      screen.getByRole('article', { name: 'Pipeline run gateway-run' })
    ).toBeTruthy()
  )
  expect(
    screen.queryByRole('article', { name: 'Pipeline run saved-run' })
  ).toBeNull()
  expect(
    screen.getByRole('button', { name: /^View runs: Vercel Gateway$/ })
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Watch steps' }))
  expect(
    screen.getByRole('list', { name: 'One pipeline steps' }).textContent
  ).toContain('Tag Complete')
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

test('the form enforces 200 selected plates and keeps the Group limit', async () => {
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
  fireEvent.click(screen.getByRole('checkbox', { name: 'Group' }))
  expect(
    document.getElementById(start.getAttribute('aria-describedby') ?? '')
      ?.textContent
  ).toContain('Group needs up to 25 plates from one state')
  expect(start.disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Group' }))
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
  expect(screen.getByText('EST 00:16 processing time')).toBeTruthy()
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
