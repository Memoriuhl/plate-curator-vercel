import { moveState } from '../lib/review/move-state'
import type { StateMove } from '../lib/review/state-move'
import { createContext, Profiler, useContext } from 'react'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PlatePage } from '../components/plate-page/plate-page'
import { slimPlate } from '../components/plate-page/types'
import { FamilyGrid } from '../components/dashboard/family-grid'
import { SelectedBatchBar } from '../components/dashboard/selected-batch-bar'
import { projectFamilyPlate } from '../components/dashboard/family-data'
import {
  LiveSignalProvider,
  type LiveSignalSource,
} from '../lib/client/live-signal'
import { ApiError } from '../lib/client/api'
import { createMemoryStore } from '../lib/review/memory-store'
import { POST as familyDrop } from '../app/api/batches/[id]/family-merge/route'
import { PATCH as patchPlate } from '../app/api/batches/[id]/plates/[plateId]/route'
import { plateSelection } from '../components/dashboard/plate-selection'
import { proposeEdit, reorderState } from '../lib/review/batch'
import { batchDetail } from '../lib/review/queries'
import { respond } from '../lib/server/respond'
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
  /** Render anchor links without a router dependency in the shared conflict fixture. */ default:
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
      /** Skip row measurement in the test virtualizer's fixed layout. */
      measureElement: () => {},
      /** Accept focus-driven index changes without performing real browser scrolling. */ scrollToIndex:
        () => {},
    }),
}))

const editor: Actor = { uid: 'editor-uid', name: 'Editor', role: 'editor' }
const owner: Actor = { uid: 'owner-uid', name: 'Owner', role: 'owner' }
vi.mock('../lib/server/catalog-head', () => ({ catalogChanged: vi.fn() }))
vi.mock('../lib/server/context', () => ({
  /**
   * Use the fixture request header to choose the editor or owner for route
   * authorization.
   */
  currentActor: async (request: Request) => ({
    ok: true,
    actor: request.headers.get('Authorization') === owner.uid ? owner : editor,
  }),
  /** Supply isolated review dependencies to the route or workflow under test. */
  reviewDeps: () => deps,
}))
const plates: Plate[] = [
  {
    id: 'AK.a',
    state: 'AK',
    image: '',
    slug: 'a',
    displayName: 'Army',
    isStandard: true,
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
  isStandard: plate.isStandard ?? false,
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
    // 'shared' is the environment's shared draft; any other id is a Batch from before it.
    ...(id === 'shared' ? { kind: 'shared-draft' as const } : {}),
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
 * Build a per-actor session backed by the shared in-memory review store and request
 * logs.
 */
function session(actor: Actor, id: string | null = 'shared') {
  return {
    user: { uid: actor.uid },
    params: new URLSearchParams(id === null ? '' : 'batch=' + id),
    api: {
      /**
       * Read current batch data as the fixture actor and count reads for refresh
       * assertions.
       */
      get: async (path: string) => {
        reads.set(actor.uid + path, (reads.get(actor.uid + path) ?? 0) + 1)
        if (path === '/api/me') return { ...actor, draftId: 'shared' }
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
       * Route fixture writes through review operations while recording the actor and
       * submitted payload.
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
        if (method === 'PUT') {
          const result = await moveState(deps, actor, {
            batchId: path.split('/')[3],
            state: 'AK',
            ...(body as {
              operationId: string
              moves: StateMove[]
            }),
          })
          if (!result.ok) {
            const response = respond(result)
            throw new ApiError(
              response.status,
              result.error,
              await response.json()
            )
          }
          return result.value
        }
        if (method === 'POST' && path.endsWith('/family-merge')) {
          const response = await familyDrop(
            new Request('https://fixture.invalid' + path, {
              method,
              headers: { Authorization: actor.uid },
              body: JSON.stringify(body),
            }),
            { params: Promise.resolve({ id: path.split('/')[3] }) }
          )
          const parsed = await response.json()
          if (!response.ok)
            throw new ApiError(response.status, parsed.error, parsed)
          return parsed
        }
        if (method !== 'PATCH') throw new Error('Unexpected write ' + path)
        const [, , , batchId, , plateId] = path.split('/')
        const response = await patchPlate(
          new Request('https://fixture.invalid' + path, {
            method,
            headers: { Authorization: actor.uid },
            body: JSON.stringify(body),
          }),
          { params: Promise.resolve({ id: batchId, plateId }) }
        )
        const parsed = await response.json()
        if (!response.ok)
          throw new ApiError(response.status, parsed.error, parsed)
        return parsed
      },
    },
  }
}
/**
 * Render a plate detail with its fixture neighbors inside the collaborative workspace.
 */
function Page({ index = 1 }: { index?: number }) {
  return (
    <PlatePage
      plate={{
        ...slimPlate(cards[index]),
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
  )
}
/**
 * Mount one collaborator with their own session and cache while sharing the server
 * store.
 */
function Workspace({
  actor,
  page = false,
  index = 1,
}: {
  actor: Actor
  page?: boolean
  index?: number
}) {
  return (
    <Context.Provider value={session(actor)}>
      <SWRConfig
        value={{
          /** Give the rendered test its own isolated SWR cache. */ provider:
            () => new Map(),
          dedupingInterval: 0,
          shouldRetryOnError: false,
          revalidateOnFocus: false,
        }}
      >
        <LiveSignalProvider value={source}>
          {page ? (
            <Page index={index} />
          ) : (
            <>
              <SelectedBatchBar />
              <FamilyGrid plates={gridPlates} catalogVersion={1} />
            </>
          )}
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

/** Move across the grid and let the new drop preview become visible. */
function hoverDrop(element: Element, x: number, y = 100) {
  vi.useFakeTimers()
  try {
    pointer(element, 'pointermove', x, y)
    act(() => vi.advanceTimersByTime(450))
  } finally {
    vi.useRealTimers()
  }
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
      element.querySelectorAll('[data-drag-variant]').forEach((row, index) => {
        row.getBoundingClientRect = () =>
          new DOMRect(left + 16, 140 + index * 54, 218, 48)
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
  plateSelection.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Find a named field within the specified collaborator's rendered view. */
const box = (view: ReturnType<typeof render>, label = 'Description') =>
  within(view.container).getByRole('textbox', {
    name: label,
  }) as HTMLInputElement
/**
 * Find an action button within one collaborator's view to distinguish it from the other.
 */
const button = (view: ReturnType<typeof render>, name: string) =>
  within(view.container).getByRole('button', { name })
/** Wait until the collaborator's batch has an active live revision subscription. */
async function ready(view: ReturnType<typeof render>) {
  await waitFor(() => expect(view.container.textContent).toContain('Live'))
}

test.each([
  ['pointer', 'order'],
  ['pointer', 'tag'],
  ['keyboard', 'order'],
  ['keyboard', 'tag'],
] as const)(
  'a stale %s promotion composes with a %s save when the Standard stays put',
  async (mode, change) => {
    const first = render(<Workspace actor={editor} />)
    const second = render(<Workspace actor={owner} />)
    await ready(first)
    await ready(second)
    targetRects(first.container)
    const handle = first.container.querySelector<HTMLElement>(
      '[data-plate-row="AK.v"]'
    )!
    if (mode === 'pointer') {
      pointer(handle, 'pointerdown', 100)
      hoverDrop(handle, 540, 100)
    } else {
      fireEvent.keyDown(handle, { key: ' ', shiftKey: true })
      fireEvent.keyDown(window, { key: 'ArrowRight' })
    }
    const order = ['AK.b', 'AK.a', 'AK.v']
    const revision = (await deps.store.getBatch('shared'))!.revision
    await act(async () => {
      if (change === 'order')
        expect(
          (
            await reorderState(deps, owner, {
              batchId: 'shared',
              state: 'AK',
              batchRevision: revision,
              order,
              standard: { from: 'AK.a', to: order[0] },
            })
          ).ok
        ).toBe(true)
      else await remote({ tags: ['remote tag'] }, 'AK.b')
    })
    expect(
      Array.from(
        first.container.querySelectorAll<HTMLElement>('[data-drag-family]')
      ).map((el) => el.dataset.dragFamily)
    ).not.toEqual(['AK.b', 'AK.a'])
    if (mode === 'pointer') pointer(handle, 'pointerup', 540, 100)
    else fireEvent.keyDown(window, { key: ' ' })
    if (mode === 'keyboard' && change === 'order') {
      await waitFor(() =>
        expect(first.container.textContent).toContain(
          'The Standard changed. Reload and confirm the new Standard again.'
        )
      )
      expect((await saved()).proposed.templateRole).toBe('variant')
      expect((await deps.store.getBatch('shared'))!.revision).toBe(revision + 1)
      return
    }
    await waitFor(() =>
      expect(first.container.textContent).toContain('Dropped')
    )
    expect((await saved()).proposed.templateRole).toBe('template')
    expect((await deps.store.getBatch('shared'))!.revision).toBe(revision + 2)
    expect(
      requests.filter((r) => r.method === 'PUT').at(-1)?.body
    ).toMatchObject({
      moves: [{ plateIds: ['AK.v'], promote: true }],
    })
    if (change === 'order')
      expect((await deps.store.getBatch('shared'))!.stateOrders.AK[0]).toBe(
        'AK.b'
      )
    else expect((await saved('AK.b')).proposed.tags).toEqual(['remote tag'])
  }
)

test.each(['pointer', 'keyboard'] as const)(
  'two sessions see a successful %s promotion and order together; other Batch saves do not conflict',
  async (mode) => {
    const first = render(<Workspace actor={editor} />)
    const second = render(<Workspace actor={owner} />)
    await ready(first)
    await ready(second)
    targetRects(first.container)
    const handle = first.container.querySelector<HTMLElement>(
      '[data-plate-row="AK.v"]'
    )!
    if (mode === 'pointer') {
      pointer(handle, 'pointerdown', 100)
      hoverDrop(handle, 540)
    } else {
      fireEvent.keyDown(handle, { key: ' ', shiftKey: true })
      fireEvent.keyDown(window, { key: 'ArrowRight' })
      fireEvent.keyDown(window, { key: 'ArrowRight' })
    }
    expect(
      (
        await reorderState(deps, owner, {
          batchId: 'other',
          state: 'AK',
          batchRevision: 0,
          standard: { from: 'AK.a', to: 'AK.b' },
          order: ['AK.b', 'AK.a', 'AK.v'],
        })
      ).ok
    ).toBe(true)
    if (mode === 'pointer') pointer(handle, 'pointerup', 540)
    else fireEvent.keyDown(window, { key: ' ' })
    await waitFor(() =>
      expect(first.container.textContent).toContain('Dropped')
    )
    await waitFor(() =>
      expect(
        second.container.querySelector('[data-drag-family="AK.v"]')
      ).toBeTruthy()
    )
    expect((await saved()).proposed).toMatchObject({
      templateRole: 'template',
      templateFamily: 'ak_v',
      variantOfPlateId: null,
    })
    expect(await deps.store.getBatch('shared')).toMatchObject({
      revision: 1,
      stateOrders: { AK: ['AK.a', 'AK.b', 'AK.v'] },
    })
    for (const view of [first, second])
      expect(
        Array.from(
          view.container.querySelectorAll<HTMLElement>('[data-drag-family]')
        ).map((el) => el.dataset.dragFamily)
      ).toEqual(['AK.a', 'AK.b', 'AK.v'])
    first.unmount()
    const reloaded = render(<Workspace actor={editor} />)
    await ready(reloaded)
    expect(
      Array.from(
        reloaded.container.querySelectorAll<HTMLElement>('[data-drag-family]')
      ).map((el) => el.dataset.dragFamily)
    ).toEqual(['AK.a', 'AK.b', 'AK.v'])
  }
)
/** Type into a field in the selected collaborator's view. */
function input(
  view: ReturnType<typeof render>,
  value: string,
  label = 'Description'
) {
  fireEvent.change(box(view, label), { target: { value } })
}
/** Submit the editor field using its multiline keyboard shortcut. */
function save(view: ReturnType<typeof render>, label = 'Description') {
  fireEvent.keyDown(box(view, label), { key: 'Enter', ctrlKey: true })
}
/** Read the persisted draft entry for a plate to assert the final server-side value. */
async function saved(plateId = 'AK.v') {
  const detail = await batchDetail(deps, 'shared')
  if (!detail.ok) throw new Error('Missing Batch')
  return detail.value.plates.find((entry) => entry.proposed.id === plateId)!
}
/**
 * Commit a remote field change against the real stored revision inside React's test
 * boundary.
 */
async function remote(fields: EditableFields, plateId = 'AK.v') {
  const entry = await saved(plateId)
  await act(async () => {
    expect(
      (
        await proposeEdit(deps, owner, {
          batchId: 'shared',
          plateId,
          baseRevision: entry.revision,
          fields,
        })
      ).ok
    ).toBe(true)
  })
}
/**
 * Render two collaborators and arrange an overlapping story edit to exercise revision
 * conflicts.
 */
async function conflictPair() {
  const first = render(<Workspace actor={owner} page />)
  const second = render(<Workspace actor={editor} page />)
  await ready(first)
  await ready(second)
  input(second, 'My story')
  input(first, 'Saved story')
  save(first)
  await waitFor(() =>
    expect(
      second.container
        .querySelector('[data-batch-id]')
        ?.getAttribute('data-batch-revision')
    ).toBe('1')
  )
  save(second)
  await waitFor(() =>
    expect(within(second.container).getByRole('alert').textContent).toContain(
      'My story'
    )
  )
  expect(within(second.container).getByRole('alert').textContent).toContain(
    'Owner saved this field'
  )
  return { first, second }
}

test('a stale family drop recognizes a plate already moved into the destination', async () => {
  const first = render(<Workspace actor={editor} />)
  const second = render(<Workspace actor={owner} page index={2} />)
  await ready(first)
  await ready(second)
  targetRects(first.container)
  const handle = first.container.querySelector<HTMLElement>(
    '[data-plate-row="AK.v"]'
  )!
  pointer(handle, 'pointerdown', 100)
  pointer(handle, 'pointermove', 110)
  fireEvent.click(button(second, 'Add Variant to family'))
  await waitFor(() =>
    expect(
      first.container
        .querySelector('[data-batch-id]')
        ?.getAttribute('data-batch-revision')
    ).toBe('1')
  )
  expect(
    within(first.container)
      .getByRole('article', { name: 'Army family' })
      .querySelector('[data-drag-variant="AK.v"]')
  ).toBeTruthy()
  hoverDrop(handle, 400)
  pointer(handle, 'pointerup', 400)
  await waitFor(() =>
    expect(first.container.textContent).toContain(
      'No plates moved. 1 already in this family'
    )
  )
  expect(
    within(
      within(first.container).getByRole('article', { name: 'Navy family' })
    ).getByText('Variant')
  ).toBeTruthy()
  expect(
    requests.filter(
      (r) => r.actor === editor.uid && r.path.endsWith('/family-merge')
    )
  ).toEqual([
    expect.objectContaining({
      body: expect.objectContaining({
        destinationId: 'AK.b',
        plateIds: ['AK.v'],
      }),
    }),
  ])
  expect((await deps.store.getBatch('shared'))!.revision).toBe(1)
})

test('a saved family drop survives a fresh workspace load as a draft', async () => {
  const first = render(<Workspace actor={editor} />)
  await ready(first)
  targetRects(first.container)
  const handle = first.container.querySelector<HTMLElement>(
    '[data-plate-row="AK.v"]'
  )!
  pointer(handle, 'pointerdown', 100)
  hoverDrop(handle, 400)
  pointer(handle, 'pointerup', 400)
  await waitFor(() =>
    expect(first.container.textContent).toContain('1 plate moved')
  )
  first.unmount()
  const collaborator = render(<Workspace actor={owner} />)
  await ready(collaborator)
  /** Find the requested family article within the collaborator's accessible grid. */
  const family = (name: string) =>
    within(within(collaborator.container).getByRole('article', { name }))
  expect(family('Navy family').getByText('Variant')).toBeTruthy()
  expect(collaborator.container.textContent).not.toContain('Published catalog')
  expect(
    within(collaborator.container).queryByRole('button', {
      name: 'Show published families',
    })
  ).toBeNull()
  expect((await deps.store.getBatch('shared'))?.baselineVersion).toBe(1)
  expect((await deps.baselineAtVersion(1, 'AK.v'))?.variantOfPlateId).toBe(
    'AK.a'
  )
})

test.each(['Description', 'Template family', 'Add tag'])(
  'remote updates preserve open %s input and its original precondition',
  async (label) => {
    const first = render(<Workspace actor={editor} page />)
    const second = render(<Workspace actor={owner} page />)
    await ready(first)
    await ready(second)
    input(first, 'local', label)
    input(second, 'Remote story')
    save(second)
    await waitFor(() =>
      expect(
        first.container
          .querySelector('[data-batch-id]')
          ?.getAttribute('data-batch-revision')
      ).toBe('1')
    )
    expect(box(first, label).value).toBe('local')
    save(first, label)
    await waitFor(() => expect(button(first, 'Keep saved')).toBeTruthy())
    expect(
      requests.filter((r) => r.actor === editor.uid && r.method === 'PATCH')[0]
        .body
    ).toMatchObject({ baseRevision: plateRevision(plates[1]) })
    expect(within(first.container).getByRole('alert').textContent).toContain(
      'local'
    )
  }
)

test('cancelling input applies the latest saved values without a write', async () => {
  const first = render(<Workspace actor={editor} page />)
  const second = render(<Workspace actor={owner} page />)
  await ready(first)
  await ready(second)
  input(first, 'Local story')
  input(second, 'Remote story')
  save(second)
  await waitFor(() =>
    expect(
      first.container
        .querySelector('[data-batch-id]')
        ?.getAttribute('data-batch-revision')
    ).toBe('1')
  )
  fireEvent.keyDown(box(first), { key: 'Escape' })
  expect(box(first).value).toBe('Remote story')
  expect(
    requests.filter((r) => r.actor === editor.uid && r.method === 'PATCH')
  ).toHaveLength(0)
})

test('different Plate saves from two sessions both succeed', async () => {
  const first = render(<Workspace actor={editor} page />)
  const second = render(<Workspace actor={owner} page index={2} />)
  await ready(first)
  await ready(second)
  input(first, 'Variant story')
  input(second, 'Navy story')
  save(first)
  save(second)
  await waitFor(async () =>
    expect((await deps.store.getBatch('shared'))?.revision).toBe(2)
  )
  expect((await saved()).proposed.description).toBe('Variant story')
  expect((await saved('AK.b')).proposed.description).toBe('Navy story')
})

test('same Plate saves from the same revision conflict even for different fields and retain the attempted fields only', async () => {
  const first = render(<Workspace actor={editor} page index={2} />)
  const second = render(<Workspace actor={owner} page index={2} />)
  await ready(first)
  await ready(second)
  input(first, 'My story')
  fireEvent.click(button(second, 'Set as Standard'))
  fireEvent.click(document.querySelector('[data-slot=alert-dialog-action]')!)
  await waitFor(() =>
    expect(
      first.container
        .querySelector('[data-batch-id]')
        ?.getAttribute('data-batch-revision')
    ).toBe('1')
  )
  save(first)
  await waitFor(() => expect(button(first, 'Keep saved')).toBeTruthy())
  const alert = within(first.container).getByRole('alert')
  expect(alert.textContent).toContain('Proposed: My story')
  expect(alert.textContent).not.toContain('isStandard')
  expect((await saved('AK.b')).proposed).toMatchObject({ isStandard: true })
  expect((await saved('AK.b')).proposed.description).toBeUndefined()
})

test('Keep saved discards the proposal and leaves the saved Plate intact', async () => {
  const { second } = await conflictPair()
  fireEvent.click(button(second, 'Keep saved'))
  await waitFor(() => expect(box(second).value).toBe('Saved story'))
  expect(within(second.container).queryByRole('alert')).toBeNull()
  expect((await saved()).proposed.description).toBe('Saved story')
  expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(2)
})

test('Reapply mine succeeds against the saved revision shown in the conflict', async () => {
  const { first, second } = await conflictPair()
  const revision = (await saved()).revision
  fireEvent.click(button(second, 'Reapply mine'))
  await waitFor(() => expect(box(first).value).toBe('My story'))
  await waitFor(() =>
    expect(within(second.container).queryByRole('alert')).toBeNull()
  )
  expect(
    requests.filter((r) => r.method === 'PATCH').at(-1)?.body
  ).toMatchObject({ baseRevision: revision })
  expect((await saved()).proposed.description).toBe('My story')
})

test('Dashboard Reapply mine restores a deleted Variant after a competing description save', async () => {
  await remote({ deleted: true })
  const dashboard = render(<Workspace actor={editor} />)
  await ready(dashboard)
  const undo = button(dashboard, 'Undo delete')

  // The description write lands before the Dashboard receives its live signal.
  const subscribed = listeners.get('shared')!
  listeners.delete('shared')
  await remote({ description: 'Saved while the Variant was deleted' })
  listeners.set('shared', subscribed)
  const reviewed = await saved()

  fireEvent.click(undo)
  const reapply = await within(dashboard.container).findByRole('button', {
    name: 'Reapply mine',
  })
  fireEvent.click(reapply)
  await waitFor(async () => {
    expect((await saved()).proposed.deleted).not.toBe(true)
  })
  expect((await saved()).proposed.description).toBe(
    'Saved while the Variant was deleted'
  )
  expect(requests.filter((r) => r.method === 'PATCH').at(-1)?.body).toEqual({
    baseRevision: reviewed.revision,
    editVersion: 2,
    fields: { deleted: false },
  })
  expect(within(dashboard.container).queryByRole('alert')).toBeNull()
})

test('a third save before reapply produces another conflict with newer saved values', async () => {
  const { second } = await conflictPair()
  const reviewedRevision = (await saved()).revision
  await remote({ description: 'Third story' })
  await waitFor(() =>
    expect(
      second.container
        .querySelector('[data-batch-id]')
        ?.getAttribute('data-batch-revision')
    ).toBe('2')
  )
  fireEvent.click(button(second, 'Reapply mine'))
  await waitFor(() =>
    expect(within(second.container).getByRole('alert').textContent).toContain(
      'Saved: Third story'
    )
  )
  expect(within(second.container).getByRole('alert').textContent).toContain(
    'Proposed: My story'
  )
  expect(
    requests.filter((r) => r.method === 'PATCH').at(-1)?.body
  ).toMatchObject({ baseRevision: reviewedRevision })
  expect((await saved()).proposed.description).toBe('Third story')
  fireEvent.click(button(second, 'Reapply mine'))
  await waitFor(async () =>
    expect((await saved()).proposed.description).toBe('My story')
  )
})

test('an unresolved conflict keeps the proposal until an explicit resolution', async () => {
  const { second } = await conflictPair()
  expect(
    (button(second, 'Set as Standard') as HTMLButtonElement).disabled
  ).toBe(true)
  expect((button(second, 'Template') as HTMLButtonElement).disabled).toBe(true)
  expect(box(second, 'Add tag').disabled).toBe(true)
  expect(within(second.container).getByRole('alert').textContent).toContain(
    'Proposed: My story'
  )
})

test.each(['background', 'background gap', 'Backspace'] as const)(
  '%s promotion never renders the new family first or logs a runtime issue',
  async (mode) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const frames: string[][] = []
    try {
      const view = render(
        <Profiler
          id="promotion"
          onRender={() => {
            frames.push(
              Array.from(
                document.querySelectorAll<HTMLElement>('[data-drag-family]')
              ).map((element) => element.dataset.dragFamily!)
            )
          }}
        >
          <Workspace actor={editor} />
        </Profiler>
      )
      await ready(view)
      targetRects(view.container)
      const row = view.container.querySelector<HTMLElement>(
        '[data-plate-row="AK.v"]'
      )!
      if (mode.startsWith('background')) {
        const x = mode === 'background' ? 700 : 275
        pointer(row.querySelector('[data-plate-image]')!, 'pointerdown', 100)
        hoverDrop(row, x)
        pointer(row, 'pointerup', x)
      } else {
        fireEvent.click(row)
        fireEvent.keyDown(window, { key: 'Backspace' })
      }
      const expected =
        mode === 'background'
          ? ['AK.a', 'AK.b', 'AK.v']
          : ['AK.a', 'AK.v', 'AK.b']
      await waitFor(() =>
        expect(
          view.container.querySelector('[data-drag-family="AK.v"]')
        ).not.toBeNull()
      )
      await waitFor(async () =>
        expect(
          (await deps.store.getBatch('shared'))?.stateOrders.AK ??
            plates.map(({ id }) => id)
        ).toEqual(expected)
      )
      await waitFor(() =>
        expect(view.container.textContent).toContain(
          mode === 'Backspace' ? '1 plate is now a Template' : 'Dropped'
        )
      )
      expect(frames.some((frame) => frame.includes('AK.v'))).toBe(true)
      expect(
        frames
          .filter((frame) => frame.includes('AK.v'))
          .every((frame) => JSON.stringify(frame) === JSON.stringify(expected))
      ).toBe(true)
      expect(
        Array.from(
          view.container.querySelectorAll<HTMLElement>('[data-drag-family]')
        ).map((element) => element.dataset.dragFamily)
      ).toEqual(expected)
      expect(error).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
      warn.mockRestore()
    }
  }
)

test('the Template context menu confirms demoting the Standard and moves the whole eligible selection', async () => {
  const view = render(<Workspace actor={editor} />)
  await ready(view)
  const variant = view.container.querySelector('[data-plate-row="AK.v"]')!
  const destination = view.container.querySelector('[data-plate-row="AK.b"]')!
  const foreign = { ...cards[1], id: 'CA.v', state: 'CA' }
  fireEvent.click(variant)
  act(() => plateSelection.add([cards[0], foreign]))
  fireEvent.contextMenu(destination, { clientX: 320, clientY: 30 })
  const menu = within(document.body).getByRole('menuitem', {
    name: 'Move selection (3) to this Template',
  })
  expect(plateSelection.has('AK.v')).toBe(true)
  fireEvent.click(menu)
  let dialog = await screen.findByRole('alertdialog', {
    name: /Make .* Standard/,
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(
    requests.filter((request) => request.path.endsWith('/family-merge'))
  ).toEqual([])
  expect(plateSelection.snapshot().map(({ id }) => id)).toEqual([
    'AK.v',
    'AK.a',
    foreign.id,
  ])
  fireEvent.contextMenu(destination, { clientX: 320, clientY: 30 })
  fireEvent.click(
    screen.getByRole('menuitem', {
      name: 'Move selection (3) to this Template',
    })
  )
  dialog = await screen.findByRole('alertdialog', { name: /Make .* Standard/ })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Make Standard' }))
  await waitFor(async () => {
    expect((await saved()).proposed.variantOfPlateId).toBe('AK.b')
    expect(plateSelection.has('AK.v')).toBe(false)
  })
  expect(plateSelection.has('AK.a')).toBe(false)
  expect(plateSelection.has(foreign.id)).toBe(true)
  expect((await saved('AK.a')).proposed).toMatchObject({
    isStandard: false,
    variantOfPlateId: 'AK.b',
  })
  expect((await saved('AK.b')).proposed.isStandard).toBe(true)
  expect(view.container.textContent).toContain(
    'Skipped 1 plate from another state'
  )
  expect(
    requests.filter((request) => request.path.endsWith('/family-merge'))
  ).toEqual([
    expect.objectContaining({
      body: expect.objectContaining({
        operationId: expect.any(String),
        destinationId: 'AK.b',
        plateIds: ['AK.v', 'AK.a'],
        standard: { from: 'AK.a', to: 'AK.b' },
      }),
    }),
  ])
})

test('only eligible Template cards offer the context action', async () => {
  const view = render(<Workspace actor={editor} />)
  await ready(view)
  const row = (id: string) =>
    view.container.querySelector('[data-plate-row="' + id + '"]')!
  const empty = fireEvent.contextMenu(row('AK.b'))
  expect(empty).toBe(true)
  fireEvent.click(row('AK.v'))
  expect(fireEvent.contextMenu(row('AK.v'))).toBe(true)
  expect(fireEvent.contextMenu(row('AK.a'))).toBe(true)
  expect(
    within(document.body).queryByRole('menuitem', {
      name: /Move selection/,
    })
  ).toBeNull()
  fireEvent.contextMenu(row('AK.b'))
  expect(
    within(document.body).getByRole('menuitem', {
      name: 'Move selection (1) to this Template',
    })
  ).toBeTruthy()
})

test.each(['Backspace', 'Delete'])(
  '%s makes the selection a Template and shows a dismissible status toast',
  async (key) => {
    const view = render(<Workspace actor={editor} />)
    await ready(view)
    fireEvent.click(view.container.querySelector('[data-plate-row="AK.v"]')!)
    fireEvent.keyDown(window, { key })
    const message = await within(document.body).findByText(
      '1 plate is now a Template',
      { selector: '[role="status"]' }
    )
    expect((await saved()).proposed.templateRole).toBe('template')
    const dismiss = within(document.body).getByRole('button', {
      name: 'Dismiss notification',
    })
    fireEvent.click(dismiss)
    expect(message.textContent).toBe('')
    expect(plateSelection.has('AK.v')).toBe(false)
  }
)
