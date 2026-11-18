import { createContext, useContext, type ReactNode } from 'react'
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from '@testing-library/react'
import { SWRConfig, type Cache } from 'swr'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PlatePage } from '../components/plate-page/plate-page'
import { slimPlate } from '../components/plate-page/types'
import { BatchActions } from '../components/dashboard/batch-actions'
import { DashboardPipelineProvider } from '../components/dashboard/pipeline-runs'
import { useDraftOverlay } from '../lib/client/hooks'
import { FamilyGrid } from '../components/dashboard/family-grid'
import { SelectedBatchBar } from '../components/dashboard/selected-batch-bar'
import { projectFamilyPlate } from '../components/dashboard/family-data'
import { useBatch, useEditPlate, useReorderState } from '../lib/client/hooks'
import {
  LiveSignalProvider,
  type LiveSignalSource,
} from '../lib/client/live-signal'
import { ApiError } from '../lib/client/api'
import { createMemoryStore } from '../lib/review/memory-store'
import { mergeFamily, type FamilyMerge } from '../lib/review/family-merge'
import { canEdit, proposeEdit } from '../lib/review/batch'
import { batchDetail } from '../lib/review/queries'
import { plateRevision } from '../lib/review/revision'
import type {
  Actor,
  EditableFields,
  ReviewBatch,
  ReviewDeps,
} from '../lib/review/types'
import type { Plate } from '../lib/catalog/types'
import { plateCards } from '../fixtures/plate-cards'

const Context = createContext<ReturnType<typeof session> | null>(null)
vi.mock('../lib/client/session', () => ({
  /** Supply the fixture session and API client to the component under test. */ useSession:
    () => useContext(Context)!,
}))
vi.mock('next/navigation', () => ({
  /** Supply the query parameters that define the fixture workspace state. */
  useSearchParams: () => useContext(Context)!.params,
  /** Supply the current pathname for the navigation state under test. */
  usePathname: () => '/states/AK',
  /** Capture or stub navigation so the test can drive routing without Next.js. */
  useRouter: () => ({ prefetch: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({
  /** Render direct links so collaborative updates can be tested without the Next.js router. */ default:
    ({ prefetch, ...props }: Record<string, unknown>) => {
      void prefetch
      return <a {...props} />
    },
}))
vi.mock('next/image', () => ({
  /** Stand in for the imported display component so the test can render its parent in isolation. */ default:
    () => <span />,
}))
vi.mock('../components/dashboard/use-grid-entrance', () => ({
  /** Stub grid entrance animations so the fixture does not require browser animation support. */ useGridEntrance:
    () => {},
}))
vi.mock('../components/dashboard/use-drag-flip', () => ({
  /** Stub animated grid reflow so the test can focus on drag behavior. */ useDragFlip:
    () => {},
}))
vi.mock('@tanstack/react-virtual', () => ({
  /** Render predictable virtual rows without depending on a real browser viewport. */ useWindowVirtualizer:
    () => ({
      /** Expose the deterministic virtual rows used by the test layout. */
      getVirtualItems: () => [{ key: 0, index: 0, start: 420 }],
      /** Report the virtual list size expected by the layout fixture. */ getTotalSize:
        () => 600,
      /**
       * Keep the fixture's virtual rows at their synthetic sizes instead of measuring the
       * DOM.
       */
      measureElement: () => {},
      /** Accept virtual scroll requests without moving the test viewport. */ scrollToIndex:
        () => {},
    }),
}))

const editor: Actor = { uid: 'editor-uid', name: 'Editor', role: 'editor' }
const owner: Actor = { uid: 'owner-uid', name: 'Owner', role: 'owner' }
const plates: Plate[] = [
  {
    id: 'AK.a',
    state: 'AK',
    image: '',
    slug: 'a',
    displayName: 'Army',
    tags: [],
    templateRole: 'template',
    templateFamily: 'army',
  },
  {
    id: 'AK.v',
    state: 'AK',
    image: '',
    slug: 'v',
    displayName: 'Variant',
    tags: [],
    templateRole: 'variant',
    templateFamily: 'army',
    variantOfPlateId: 'AK.a',
  },
  {
    id: 'AK.b',
    state: 'AK',
    image: '',
    slug: 'b',
    displayName: 'Navy',
    tags: [],
    templateRole: 'template',
    templateFamily: 'navy',
  },
]
const cards = plates.map((plate, index) => ({
  ...plateCards[0],
  ...plate,
  imageUrl: null,
  variantOfPlateId: plate.variantOfPlateId ?? null,
  isStandard: false,
  sortOrder: index,
  revision: plateRevision(plate),
}))
const gridPlates = cards.map(projectFamilyPlate)
/**
 * Build a fixture batch with its baseline and plate selection for the current review
 * scenario.
 */
function batch(id = 'shared', actor = editor): ReviewBatch {
  return {
    id,
    name: id + ' Batch',
    createdBy: actor.uid,
    createdByName: actor.name,
    createdAt: '2026-11-16',
    state: 'open',
    revision: 0,
    baselineVersion: 1,
    stateOrders: {},
    plateIds: plates.map((p) => p.id),
    approval: null,
  }
}
let tagRevision: string
let deps: ReviewDeps
let listeners: Map<string, Set<(revision: number | null) => void>>
let signals: Map<string, number>
let requests: { actor: string; method: string; path: string; body: unknown }[]
let release: (() => void) | undefined
let hold: Promise<void> | undefined
let reads: Map<string, number>
let disposed: string[]
let failures: Map<string, (error: { code?: string }) => void>
let missingSignal: boolean
let denySignal: boolean
const source: LiveSignalSource = {
  /**
   * Capture each batch subscription and exercise its current revision, error and
   * disposal paths.
   */
  subscribe(_env, id, next, error) {
    failures.set(id, error)
    const set = listeners.get(id) ?? new Set()
    listeners.set(id, set)
    set.add(next)
    if (denySignal) queueMicrotask(() => error({ code: 'permission-denied' }))
    else next(missingSignal ? null : (signals.get(id) ?? null))
    return () => {
      set.delete(next)
      disposed.push(id)
    }
  },
}
/** Deliver the supplied batch revision to currently subscribed test listeners. */
function emit(id: string, revision: number) {
  signals.set(id, revision)
  listeners.get(id)?.forEach((next) => next(revision))
}
/**
 * Create a fixture session that routes one collaborator's requests to the shared batch
 * store.
 */
function session(actor: Actor, id: string | null = 'shared') {
  return {
    user: { uid: actor.uid },
    params: new URLSearchParams(id === null ? '' : 'batch=' + id),
    api: {
      /**
       * Read batch detail or list data and count the requesting actor's cache refreshes.
       */
      get: async (path: string) => {
        reads.set(actor.uid + path, (reads.get(actor.uid + path) ?? 0) + 1)
        if (path === '/api/me') return actor
        if (path === '/api/jobs/tag-job')
          return {
            state: 'completed',
            suggestions: ['naval'],
            inputHash: tagRevision,
          }
        if (path.startsWith('/api/batches?'))
          return (await deps.store.list({ states: ['open'] })).filter(
            (b) => b.createdBy === actor.uid
          )
        if (path.startsWith('/api/batches/')) {
          const result = await batchDetail(deps, path.split('/')[3])
          if (!result.ok) throw new ApiError(404, result.error, {})
          return result.value
        }
        throw new Error(path)
      },
      /**
       * Apply the collaborator's field or family change and record the request for
       * assertions.
       */
      send: async (method: string, path: string, body: unknown) => {
        requests.push({ actor: actor.uid, method, path, body })
        if (path === '/api/live-access')
          return {
            envKey: 'test',
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          }
        if (path.endsWith('/tagging')) {
          const result = await batchDetail(deps, path.split('/')[3])
          if (!result.ok) throw new Error('Missing Batch')
          tagRevision = result.value.plates.find(
            (p) => p.proposed.id === 'AK.v'
          )!.revision
          return { jobId: 'tag-job', runId: 'tag-workflow' }
        }
        if (method === 'POST' && path.endsWith('/family-merge')) {
          await hold
          const result = await mergeFamily(deps, actor, {
            batchId: path.split('/')[3],
            ...(body as FamilyMerge & { batchRevision: number }),
          })
          if (!result.ok)
            throw new ApiError(
              result.error === 'forbidden' ? 403 : 409,
              result.error,
              result
            )
          return result.value
        }
        if (method !== 'PATCH') throw new Error('Unexpected write ' + path)
        await hold
        const [, , , batchId, , plateId] = path.split('/')
        const result = await proposeEdit(deps, actor, {
          batchId,
          plateId,
          ...(body as { baseRevision: string; fields: EditableFields }),
        })
        if (!result.ok)
          throw new ApiError(
            result.error === 'forbidden' ? 403 : 409,
            result.error,
            result
          )
        return result.value
      },
    },
  }
}
/** Render the plate's current overlaid tags with the real tagging action. */
function TagActions() {
  const overlaid = useDraftOverlay(cards)
  return (
    <>
      <DashboardPipelineProvider>
        <BatchActions
          underTagged={overlaid.filter((p) => p.id === 'AK.v')}
          stateCode="AK"
          stateName="Alaska"
        />
      </DashboardPipelineProvider>
      <output>{overlaid.find((p) => p.id === 'AK.v')?.tags.join(', ')}</output>
    </>
  )
}
/** Expose two edit actions and the resulting tag values to test serialized writes. */
function EditTwice() {
  const [plate] = useDraftOverlay([cards[1]])
  const { edit } = useEditPlate()
  return (
    <>
      <button onClick={() => void edit(plate, { tags: ['first'] })}>
        First save
      </button>
      <button onClick={() => void edit(plate, { tags: ['second'] })}>
        Second save
      </button>
      <output>{plate.tags.join(', ')}</output>
    </>
  )
}
/**
 * Expose real edit and reorder hooks through controls for the live batch close scenario.
 */
function Probe() {
  const edits = useEditPlate()
  const order = useReorderState()
  return (
    <>
      <button onClick={() => void edits.edit(cards[1], { tags: ['attempt'] })}>
        Attempt edit
      </button>
      <button
        onClick={() =>
          void order.reorder(
            'AK',
            plates.map((p) => p.id)
          )
        }
      >
        Attempt order
      </button>
    </>
  )
}
/** Render one live workspace under the supplied actor and an isolated SWR cache. */
function Workspace({
  value,
  cache = new Map(),
  children,
}: {
  value: ReturnType<typeof session>
  cache?: Cache
  children?: ReactNode
}) {
  return (
    <Context.Provider value={value}>
      <SWRConfig
        value={{
          /** Give the rendered test its own isolated SWR cache. */ provider:
            () => cache,
          dedupingInterval: 0,
          shouldRetryOnError: false,
          revalidateOnFocus: false,
        }}
      >
        <LiveSignalProvider value={source}>
          <SelectedBatchBar />
          <FamilyGrid plates={gridPlates} />
          {children}
        </LiveSignalProvider>
      </SWRConfig>
    </Context.Provider>
  )
}
/**
 * Dispatch a synthetic pointer event so the test can drive a drag without browser
 * pointer automation.
 */
function pointer(element: Element, type: string, x: number, y = 100) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  })
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' },
  })
  act(() => {
    ;(type === 'pointerdown' ? element : window).dispatchEvent(event)
  })
}
/**
 * Assign explicit family rectangles so drag hit testing is deterministic in the test
 * DOM.
 */
function targetRects(container: HTMLElement) {
  container
    .querySelectorAll<HTMLElement>('[data-drag-family]')
    .forEach((element) => {
      const left = element.dataset.dragFamily === 'AK.b' ? 300 : 0
      element.getBoundingClientRect = () => ({
        left,
        right: left + 250,
        top: 0,
        bottom: 300,
        width: 250,
        height: 300,
        x: left,
        y: 0,
        /** Complete the DOM rectangle interface for the fixed geometry used by the drag test. */ toJSON() {},
      })
    })
}
beforeEach(() => {
  failures = new Map()
  missingSignal = false
  denySignal = false
  requests = []
  listeners = new Map()
  signals = new Map([
    ['shared', 0],
    ['other', 0],
  ])
  reads = new Map()
  disposed = []
  hold = undefined
  release = undefined
  const store = createMemoryStore([batch(), batch('other', owner)])
  const commit = store.commit.bind(store)
  store.commit = async (...args) => {
    const result = await commit(...args)
    if (result === 'ok') emit(args[0], args[2].batch.revision)
    return result
  }
  deps = {
    store,
    /** Resolve the plate by ID from the fixture baseline. */ baseline: async (
      id
    ) => plates.find((p) => p.id === id) ?? null,
    /** Resolve the plate by ID from the fixture baseline. */ baselineAtVersion:
      async (_v, id) => plates.find((p) => p.id === id) ?? null,
    /** Return the fixture state order used by the review or queue operation. */ stateBaseline:
      async () => plates,
    /** Pin the operation clock so timestamps and lease checks are reproducible. */ now: () =>
      '2026-11-16',
  }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({
      left: 0,
      right: 1500,
      top: 0,
      bottom: 300,
      width: 1500,
      height: 300,
      x: 0,
      y: 0,
      /** Complete the DOM rectangle interface for the fixed geometry used by the drag test. */ toJSON() {},
    })
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      /** Satisfy observer registration in the test DOM without starting a browser observer. */ observe() {}
      /** Satisfy observer cleanup in the test DOM without installing a browser observer. */ disconnect() {}
    }
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    /** Stand in for media-query listener registration in the test DOM. */ addEventListener() {},
    /** Stand in for media-query listener cleanup in the test DOM. */ removeEventListener() {},
  }))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('Editor regroup is optimistic, commits only to the selected Batch, and reaches the Owner live', async () => {
  const first = render(
    <Workspace value={session(editor)}>
      <TagActions />
    </Workspace>
  )
  const second = render(
    <Workspace value={session(owner)}>
      <TagActions />
    </Workspace>
  )
  await waitFor(() =>
    expect(
      first.container.querySelector<HTMLElement>('[data-plate-row="AK.v"]')!
    ).toBeTruthy()
  )
  await waitFor(() =>
    expect(
      second.container
        .querySelector('[data-batch-id]')
        ?.getAttribute('data-batch-revision')
    ).toBe('0')
  )
  expect(canEdit(batch(), editor)).toBe(true)
  expect(canEdit(batch(), owner)).toBe(true)
  hold = new Promise((resolve) => {
    release = resolve
  })
  targetRects(first.container)
  const handle = first.container.querySelector<HTMLElement>(
    '[data-plate-row="AK.v"]'
  )!
  pointer(handle, 'pointerdown', 100)
  pointer(handle, 'pointermove', 400)
  pointer(handle, 'pointerup', 400)
  await waitFor(() =>
    expect(
      within(
        within(first.container).getByRole('article', { name: 'Navy family' })
      ).getByText('Variant')
    ).toBeTruthy()
  )
  expect(
    within(
      within(second.container).getByRole('article', { name: 'Army family' })
    ).getByText('Variant')
  ).toBeTruthy()
  await act(async () => {
    release!()
  })
  await waitFor(() =>
    expect(
      within(
        within(second.container).getByRole('article', { name: 'Navy family' })
      ).getByText('Variant')
    ).toBeTruthy()
  )
  await waitFor(() =>
    expect(
      first.container
        .querySelector('[data-batch-id]')
        ?.getAttribute('data-batch-revision')
    ).toBe('1')
  )
  expect(
    second.container
      .querySelector('[data-batch-id]')
      ?.getAttribute('data-batch-revision')
  ).toBe('1')
  for (const view of [first, second])
    expect(
      view.container
        .querySelector('[data-batch-id]')
        ?.getAttribute('data-batch-id')
    ).toBe('shared')
  expect(await deps.store.getBatch('shared')).toMatchObject({
    state: 'open',
    approval: null,
    revision: 1,
  })
  expect(requests.filter((r) => r.path !== '/api/live-access')).toEqual([
    expect.objectContaining({
      method: 'POST',
      path: '/api/batches/shared/family-merge',
    }),
  ])
  fireEvent.click(
    within(second.container).getByRole('button', { name: 'Run pipeline' })
  )
  fireEvent.click(
    within(document.body).getByRole('button', { name: 'Start run' })
  )
  const accept = await within(second.container).findByRole(
    'button',
    { name: 'Accept naval for Variant' },
    { timeout: 5000 }
  )
  expect(
    (await deps.store.getEdit('shared', 'AK.v'))?.fields.tags
  ).toBeUndefined()
  fireEvent.click(accept)
  await waitFor(() =>
    expect(first.container.querySelector('output')?.textContent).toBe('naval')
  )
  await waitFor(() =>
    expect(second.container.querySelector('output')?.textContent).toBe('naval')
  )
  expect(await deps.store.getBatch('shared')).toMatchObject({
    state: 'open',
    approval: null,
    revision: 2,
  })
  expect((await deps.store.getEdit('shared', 'AK.v'))?.fields).toMatchObject({
    templateFamily: 'navy',
    tags: ['naval'],
  })
  expect(
    requests
      .filter((r) => r.path !== '/api/live-access')
      .map((r) => [r.method, r.path])
  ).toEqual([
    ['POST', '/api/batches/shared/family-merge'],
    ['POST', '/api/batches/shared/plates/AK.v/tagging'],
    ['PATCH', '/api/batches/shared/plates/AK.v'],
  ])
  expect(
    requests.filter((r) => r.method === 'PATCH').at(-1)?.body
  ).toMatchObject({ baseRevision: tagRevision })
}, 20000)

test('unavailable and read-only selections cannot edit or reorder or fall back to personal drafts', async () => {
  const missing = render(
    <Workspace value={session(editor, 'missing')}>
      <Probe />
    </Workspace>
  )
  await waitFor(() =>
    expect(missing.getByText("This Batch isn't available")).toBeTruthy()
  )
  fireEvent.click(missing.getByText('Attempt edit'))
  fireEvent.click(missing.getByText('Attempt order'))
  const missingRow = missing.container.querySelector<HTMLElement>(
    '[data-plate-row="AK.v"]'
  )!
  fireEvent.keyDown(missingRow, { key: ' ', shiftKey: true })
  pointer(missingRow, 'pointerdown', 100)
  pointer(missingRow, 'pointermove', 400)
  pointer(missingRow, 'pointerup', 400)
  expect(missingRow.className).toContain('cursor-pointer')
  missing.unmount()
  const readonly = render(
    <Workspace value={session(editor, 'other')}>
      <Probe />
    </Workspace>
  )
  await waitFor(() => expect(readonly.getByText('Read-only')).toBeTruthy())
  fireEvent.click(readonly.getByText('Attempt edit'))
  fireEvent.click(readonly.getByText('Attempt order'))
  const readonlyRow = readonly.container.querySelector<HTMLElement>(
    '[data-plate-row="AK.v"]'
  )!
  fireEvent.keyDown(readonlyRow, { key: ' ', shiftKey: true })
  pointer(readonlyRow, 'pointerdown', 100)
  pointer(readonlyRow, 'pointermove', 400)
  pointer(readonlyRow, 'pointerup', 400)
  expect(readonlyRow.className).toContain('cursor-pointer')
  await act(async () => {})
  expect(requests.filter((r) => r.path !== '/api/live-access')).toEqual([])
})

test('remote revision waits for drag settlement and preserves the lifted Plate precondition', async () => {
  const view = render(<Workspace value={session(editor)} />)
  await waitFor(() =>
    expect(
      view.container.querySelector<HTMLElement>('[data-plate-row="AK.v"]')!
    ).toBeTruthy()
  )
  targetRects(view.container)
  const handle = view.container.querySelector<HTMLElement>(
    '[data-plate-row="AK.v"]'
  )!
  pointer(handle, 'pointerdown', 100)
  pointer(handle, 'pointermove', 110)
  await act(async () => {
    await proposeEdit(deps, owner, {
      batchId: 'shared',
      plateId: 'AK.v',
      baseRevision: plateRevision(plates[1]),
      fields: {
        tags: ['remote'],
        templateFamily: 'navy',
        variantOfPlateId: 'AK.b',
      },
    })
  })
  await waitFor(() =>
    expect(
      view.container
        .querySelector('[data-batch-id]')
        ?.getAttribute('data-batch-revision')
    ).toBe('1')
  )
  expect(
    within(
      within(view.container).getByRole('article', { name: 'Army family' })
    ).getByText('Variant')
  ).toBeTruthy()
  pointer(handle, 'pointermove', 400)
  pointer(handle, 'pointerup', 400)
  await waitFor(() =>
    expect(view.container.textContent).toContain(
      'The Batch changed. Drag again using the latest selection.'
    )
  )
  expect(
    within(
      within(view.container).getByRole('article', { name: 'Navy family' })
    ).getByText('Variant')
  ).toBeTruthy()
  expect(
    requests.find((r) => r.path.endsWith('/family-merge'))?.body
  ).toMatchObject({
    batchRevision: 0,
    members: [{ id: 'AK.v', revision: plateRevision(plates[1]) }],
  })
})

test('initial catch-up coalesces bursts, ignores old signals and disposes on switch and sign-out', async () => {
  const previous = await batchDetail(deps, 'shared')
  if (!previous.ok) throw new Error('Missing fixture')
  await deps.store.commit('shared', 0, { batch: { ...batch(), revision: 3 } })
  const value = session(owner)
  const cache = new Map([['/api/batches/shared', { data: previous.value }]])
  const view = render(<Workspace value={value} cache={cache} />)
  await waitFor(() => expect(view.container.textContent).toContain('Live'))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  const key = owner.uid + '/api/batches/shared'
  expect(
    view.container
      .querySelector('[data-batch-id]')
      ?.getAttribute('data-batch-revision')
  ).toBe('3')
  const initialReads = reads.get(key)!
  expect(initialReads).toBeGreaterThan(0)
  act(() => {
    emit('shared', 2)
    emit('shared', 3)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
  expect(reads.get(key)).toBe(initialReads)
  act(() => {
    emit('shared', 4)
    emit('shared', 5)
    emit('shared', 6)
  })
  await waitFor(() => expect(reads.get(key)).toBe(initialReads + 1))
  view.rerender(<Workspace value={session(owner, 'other')} cache={cache} />)
  await waitFor(() => expect(disposed).toContain('shared'))
  expect(listeners.get('shared')?.size).toBe(0)
  view.rerender(
    <Workspace
      value={
        { ...session(owner, 'other'), user: null } as unknown as ReturnType<
          typeof session
        >
      }
      cache={cache}
    />
  )
  await waitFor(() => expect(listeners.get('other')?.size).toBe(0))
})

test('missing signals expose manual Refresh and permission failures renew only once', async () => {
  missingSignal = true
  const view = render(<Workspace value={session(owner)} />)
  await waitFor(() =>
    expect(view.getByText('Live updates unavailable')).toBeTruthy()
  )
  const before = reads.get(owner.uid + '/api/batches/shared')!
  fireEvent.click(view.getByText('Refresh'))
  await waitFor(() =>
    expect(reads.get(owner.uid + '/api/batches/shared')).toBe(before + 1)
  )
  missingSignal = false
  act(() => failures.get('shared')!({ code: 'permission-denied' }))
  await waitFor(() =>
    expect(requests.filter((r) => r.path === '/api/live-access')).toHaveLength(
      2
    )
  )
  await waitFor(() => expect(view.getByText('Live')).toBeTruthy())
  act(() => failures.get('shared')!({ code: 'permission-denied' }))
  await waitFor(() =>
    expect(view.getByText('Live updates unavailable')).toBeTruthy()
  )
  expect(requests.filter((r) => r.path === '/api/live-access')).toHaveLength(2)
})

test('grant renews before expiry and selection preserves Plate links', async () => {
  const value = session(owner)
  const send = value.api.send
  value.api.send = async (method, path, body) => {
    const response = await send(method, path, body)
    return path === '/api/live-access'
      ? {
          envKey: 'test',
          expiresAt: new Date(Date.now() + 61000).toISOString(),
        }
      : response
  }
  const view = render(<Workspace value={value} />)
  await waitFor(() => expect(view.getByText('Live')).toBeTruthy())
  expect(
    within(view.container)
      .getByRole('link', { name: 'Navy' })
      .getAttribute('href')
  ).toBe('/plates/AK.b?batch=shared')
  await waitFor(
    () =>
      expect(
        requests.filter((r) => r.path === '/api/live-access')
      ).toHaveLength(2),
    { timeout: 2000 }
  )
  expect(listeners.get('shared')?.size).toBe(1)
  expect(disposed).toContain('shared')
})

test('loading and a closed creator Batch reject every offered write', async () => {
  const value = session(editor)
  const view = render(
    <Workspace value={value}>
      <Probe />
    </Workspace>
  )
  fireEvent.click(view.getByText('Attempt edit'))
  fireEvent.click(view.getByText('Attempt order'))
  await act(async () => {})
  expect(requests.filter((r) => r.path !== '/api/live-access')).toHaveLength(0)
  view.unmount()
  await deps.store.commit('shared', 0, {
    batch: { ...batch(), state: 'published', revision: 1 },
  })
  const closed = render(
    <Workspace value={session(editor)}>
      <Probe />
    </Workspace>
  )
  await waitFor(() => expect(closed.getByText('Read-only')).toBeTruthy())
  fireEvent.click(closed.getByText('Attempt edit'))
  fireEvent.click(closed.getByText('Attempt order'))
  await act(async () => {})
  expect(requests.filter((r) => r.path !== '/api/live-access')).toHaveLength(0)
})

test('undeployed rules deny twice without console errors or renewal loops, and Refresh reads only the selected Batch', async () => {
  denySignal = true
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const value = session(owner)
  const send = value.api.send
  value.api.send = async (method, path, body) => {
    const response = await send(method, path, body)
    return path === '/api/live-access'
      ? {
          envKey: 'test',
          expiresAt: new Date(Date.now() + 61000).toISOString(),
        }
      : response
  }
  /**
   * Subscribe to an unrelated batch so the test can detect unexpectedly broad
   * invalidations.
   */
  function OtherBatch() {
    useBatch('other')
    return null
  }
  const view = render(
    <Workspace value={value}>
      <OtherBatch />
    </Workspace>
  )
  await waitFor(() =>
    expect(view.getByText('Live updates unavailable')).toBeTruthy()
  )
  await waitFor(() =>
    expect(requests.filter((r) => r.path === '/api/live-access')).toHaveLength(
      2
    )
  )
  expect(listeners.get('shared')?.size).toBe(0)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100))
  })
  expect(requests.filter((r) => r.path === '/api/live-access')).toHaveLength(2)
  const before = new Map(reads)
  fireEvent.click(view.getByText('Refresh'))
  const selectedKey = owner.uid + '/api/batches/shared'
  await waitFor(() =>
    expect(reads.get(selectedKey)).toBe(before.get(selectedKey)! + 1)
  )
  expect([...reads].filter(([key]) => key !== selectedKey)).toEqual(
    [...before].filter(([key]) => key !== selectedKey)
  )
  expect(view.getByText('Live updates unavailable')).toBeTruthy()
  expect(requests.filter((r) => r.path === '/api/live-access')).toHaveLength(2)
  expect(consoleError).not.toHaveBeenCalled()
})

test('second selected Plate save sends the draft revision and succeeds', async () => {
  const view = render(
    <Workspace value={session(editor)}>
      <EditTwice />
    </Workspace>
  )
  await waitFor(() => expect(view.container.textContent).toContain('Live'))
  fireEvent.click(view.getByText('First save'))
  await waitFor(() =>
    expect(view.container.querySelector('output')?.textContent).toBe('first')
  )
  const first = await batchDetail(deps, 'shared')
  if (!first.ok) throw new Error('Missing Batch')
  const revision = first.value.plates.find(
    (p) => p.proposed.id === 'AK.v'
  )!.revision
  fireEvent.click(view.getByText('Second save'))
  await waitFor(() =>
    expect(view.container.querySelector('output')?.textContent).toBe('second')
  )
  expect(
    requests.filter((r) => r.method === 'PATCH').map((r) => r.body)
  ).toEqual([
    { baseRevision: cards[1].revision, fields: { tags: ['first'] } },
    { baseRevision: revision, fields: { tags: ['second'] } },
  ])
})

test('stale Tag acceptance keeps the newer draft and reports stale_plate', async () => {
  const view = render(
    <Workspace value={session(owner)}>
      <TagActions />
    </Workspace>
  )
  await waitFor(() => expect(view.container.textContent).toContain('Live'))
  fireEvent.click(view.getByRole('button', { name: 'Run pipeline' }))
  fireEvent.click(
    within(document.body).getByRole('button', { name: 'Start run' })
  )
  const accept = await view.findByRole(
    'button',
    { name: 'Accept naval for Variant' },
    { timeout: 5000 }
  )
  await act(async () => {
    await proposeEdit(deps, editor, {
      batchId: 'shared',
      plateId: 'AK.v',
      baseRevision: cards[1].revision,
      fields: { tags: ['newer'] },
    })
  })
  await waitFor(() =>
    expect(view.container.querySelector('output')?.textContent).toBe('newer')
  )
  fireEvent.click(accept)
  await view.findByText('Someone changed this while you were editing.')
  expect((await deps.store.getEdit('shared', 'AK.v'))?.fields.tags).toEqual([
    'newer',
  ])
  expect(await deps.store.getBatch('shared')).toMatchObject({
    state: 'open',
    approval: null,
    revision: 1,
  })
  expect(
    requests.filter((r) => r.method === 'PATCH').at(-1)?.body
  ).toMatchObject({
    baseRevision: tagRevision,
    fields: { tags: ['newer', 'naval'] },
  })
})

test('Plate page keeps selected Batch navigation, edits twice, and runs and accepts Tag in that Batch', async () => {
  const value = session(owner)
  const view = render(
    <Context.Provider value={value}>
      <SWRConfig
        value={{
          /** Give the rendered test its own isolated SWR cache. */ provider:
            () => new Map(),
          dedupingInterval: 0,
          shouldRetryOnError: false,
        }}
      >
        <LiveSignalProvider value={source}>
          <PlatePage
            plate={{
              ...slimPlate(cards[1]),
              imageSize: { width: 320, height: 160 },
              description: null,
              sourceUrl: null,
              wikiUrl: null,
            }}
            plates={cards.map(slimPlate)}
            stateName="Alaska"
            prevId="AK.a"
            nextId="AK.b"
          />
        </LiveSignalProvider>
      </SWRConfig>
    </Context.Provider>
  )
  expect(
    view.getByRole('link', { name: 'Back to Alaska' }).getAttribute('href')
  ).toBe('/states/AK?batch=shared')
  expect(view.getByRole('link', { name: /Next/ }).getAttribute('href')).toBe(
    '/plates/AK.b?batch=shared'
  )
  await waitFor(() => expect(view.container.textContent).toContain('Live'))
  const input = view.getByRole('textbox', { name: 'Add tag' })
  for (const tag of ['first', 'second']) {
    fireEvent.change(input, { target: { value: tag } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await view.findByRole('button', { name: 'Remove tag ' + tag })
    await waitFor(() => expect(input.hasAttribute('disabled')).toBe(false))
  }
  fireEvent.click(view.getByRole('button', { name: 'Run Tag' }))
  const accept = await view.findByRole(
    'button',
    { name: 'Accept naval for Variant' },
    { timeout: 5000 }
  )
  fireEvent.click(accept)
  await view.findByRole('button', { name: 'Remove tag naval' })
  expect((await deps.store.getEdit('shared', 'AK.v'))?.fields.tags).toEqual([
    'first',
    'second',
    'naval',
  ])
  expect(
    requests.filter((r) => r.path !== '/api/live-access').map((r) => r.path)
  ).toEqual([
    '/api/batches/shared/plates/AK.v',
    '/api/batches/shared/plates/AK.v',
    '/api/batches/shared/plates/AK.v/tagging',
    '/api/batches/shared/plates/AK.v',
  ])
})
