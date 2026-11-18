import { createContext, useContext } from 'react'
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from '@testing-library/react'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PublishWorkspace } from '../components/publish/workspace'
import { ReviewWorkspace } from '../components/review/workspace'
import { BatchActions } from '../components/dashboard/batch-actions'
import { DashboardPipelineProvider } from '../components/dashboard/pipeline-runs'
import { FamilyGrid } from '../components/dashboard/family-grid'
import { SelectedBatchBar } from '../components/dashboard/selected-batch-bar'
import { projectFamilyPlate } from '../components/dashboard/family-data'
import { useReorderState } from '../lib/client/hooks'
import {
  LiveSignalProvider,
  type LiveSignalSource,
} from '../lib/client/live-signal'
import { ApiError } from '../lib/client/api'
import { createMemoryStore } from '../lib/review/memory-store'
import {
  approveBatch,
  proposeEdit,
  reorderState,
  submitBatch,
} from '../lib/review/batch'
import { discardPlateChanges } from '../lib/review/discard-changes'
import { batchDetail } from '../lib/review/queries'
import { plateRevision } from '../lib/review/revision'
import type {
  Actor,
  DraftChangeTarget,
  ReviewBatch,
  ReviewDeps,
} from '../lib/review/types'
import type { Plate } from '../lib/catalog/types'
import { plateCards } from '../fixtures/plate-cards'

const Context = createContext<ReturnType<typeof session> | null>(null)
vi.mock('../lib/client/session', () => ({
  useSession: () => useContext(Context)!,
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
  default: ({ prefetch, ...props }: Record<string, unknown>) => {
    void prefetch
    return <a {...props} />
  },
}))
vi.mock('next/image', () => ({ default: () => <span /> }))
vi.mock('../components/dashboard/use-grid-entrance', () => ({
  useGridEntrance: () => {},
}))
vi.mock('../components/dashboard/use-drag-flip', () => ({
  useDragFlip: () => {},
}))
vi.mock('@tanstack/react-virtual', () => ({
  useWindowVirtualizer: () => ({
    /** Expose the deterministic virtual rows used by the test layout. */
    getVirtualItems: () => [{ key: 0, index: 0, start: 420 }],
    getTotalSize: () => 600,
    /** Skip actual browser measurement for the fixed virtual rows in the test. */
    measureElement: () => {},
    scrollToIndex: () => {},
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
let deps: ReviewDeps
let listeners: Map<string, Set<(revision: number | null) => void>>
let signals: Map<string, number>
let requests: { actor: string; method: string; path: string; body: unknown }[]
let reads: Map<string, number>
let failures: Map<string, (error: { code?: string }) => void>
let connected: boolean
let failedOrder: unknown
const supersedeRun = vi.fn(async () => {})
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
    if (connected) next(signals.get(id) ?? null)
    return () => {
      set.delete(next)
    }
  },
}
/** Deliver the supplied batch revision to currently subscribed test listeners. */
function emit(id: string, revision: number) {
  signals.set(id, revision)
  listeners.get(id)?.forEach((next) => next(revision))
}
/** Connect one fixture actor's session to the shared batch mutations and read log. */
function session(actor: Actor, id: string | null = 'shared') {
  return {
    user: { uid: actor.uid },
    params: new URLSearchParams(id === null ? '' : 'batch=' + id),
    api: {
      /**
       * Read actor-visible batch data and count requests to observe live refresh
       * behavior.
       */
      get: async (path: string) => {
        reads.set(actor.uid + path, (reads.get(actor.uid + path) ?? 0) + 1)
        if (path === '/api/me') return actor
        if (path === '/api/publish/control') return { control: null }
        if (path.endsWith('/run'))
          return { phase: null, runId: null, outcome: null, updatedAt: null }
        if (path.endsWith('/publish')) {
          const current = (await deps.store.getBatch(path.split('/')[3]))!
          return {
            error: null,
            enabledHere: true,
            batchRevision: current.revision,
            approvalProblems: [],
            destination: 'license-plate-game-staging',
            canConfirmDraft: true,
            confirmation: await deps.store.changesSinceReview!(
              current.id,
              actor.uid,
              current.revision
            ),
          }
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
      /** Apply supported edit, order and submit requests to the shared review store. */
      send: async (method: string, path: string, body: unknown) => {
        requests.push({ actor: actor.uid, method, path, body })
        if (method === 'POST' && path.endsWith('/publish'))
          return { status: 'publishing' }
        if (path === '/api/live-access')
          return {
            envKey: 'test',
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          }
        if (
          method === 'PATCH' &&
          body &&
          typeof body === 'object' &&
          'discard' in body
        ) {
          const request = body as {
            batchRevision: number
            discard: DraftChangeTarget
          }
          const result = await discardPlateChanges(deps, actor, {
            batchId: path.split('/')[3],
            plateId: path.split('/')[5],
            batchRevision: request.batchRevision,
            target: request.discard,
          })
          if (!result.ok) throw new ApiError(409, result.error, result)
          return result.value
        }
        if (method === 'PATCH') {
          const result = await proposeEdit(deps, actor, {
            batchId: path.split('/')[3],
            plateId: path.split('/')[5],
            ...(body as {
              baseRevision: string
              fields: import('../lib/review/types').EditableFields
              standard?: import('../lib/review/types').StandardChange
            }),
          })
          if (!result.ok) throw new ApiError(409, result.error, result)
          return result.value
        }
        if (path.endsWith('/state-order/AK') || path.endsWith('/submit')) {
          const result = path.endsWith('/state-order/AK')
            ? await reorderState(deps, actor, {
                batchId: path.split('/')[3],
                state: 'AK',
                ...(body as { batchRevision: number; order: string[] }),
              })
            : await submitBatch(
                deps,
                actor,
                path.split('/')[3],
                (body as { revision: number }).revision
              )
          if (!result.ok) {
            failedOrder = result
            throw new ApiError(409, result.error, result)
          }
          return result.value
        }
        if (path.endsWith('/approve')) {
          const result = await approveBatch(
            deps,
            actor,
            path.split('/')[3],
            (body as { revision: number }).revision
          )
          if (!result.ok) throw new ApiError(409, result.error, result)
          return result.value
        }
        throw new Error('Unexpected write ' + method + ' ' + path)
      },
    },
  }
}
/** Render the workspace with a private cache for the supplied fixture session. */
function Workspace({
  value,
  page = 'dashboard',
}: {
  value: ReturnType<typeof session>
  page?: 'dashboard' | 'review' | 'publish'
}) {
  const cache = new Map()
  return (
    <Context.Provider value={value}>
      <SWRConfig
        value={{
          provider: () => cache,
          dedupingInterval: 0,
          shouldRetryOnError: false,
          revalidateOnFocus: false,
        }}
      >
        <LiveSignalProvider value={source}>
          {page === 'dashboard' && (
            <>
              <SelectedBatchBar />
              <FamilyGrid plates={gridPlates} />
              <OrderAction />
              <DashboardPipelineProvider>
                <BatchActions
                  underTagged={[]}
                  stateCode="AK"
                  stateName="Alaska"
                />
              </DashboardPipelineProvider>
            </>
          )}
          {page === 'review' && (
            <ReviewWorkspace
              states={[{ code: 'AK', name: 'Alaska', plates: [] }]}
            />
          )}
          {page === 'publish' && <PublishWorkspace />}
        </LiveSignalProvider>
      </SWRConfig>
    </Context.Provider>
  )
}
beforeEach(() => {
  connected = true
  failedOrder = undefined
  supersedeRun.mockClear()
  failures = new Map()
  requests = []
  listeners = new Map()
  signals = new Map([['shared', 0]])
  reads = new Map()
  const store = createMemoryStore([batch()])
  const commit = store.commit.bind(store)
  store.commit = async (...args) => {
    const result = await commit(...args)
    if (result === 'ok') {
      signals.set(args[0], args[2].batch.revision)
      if (connected) emit(args[0], args[2].batch.revision)
    }
    return result
  }
  deps = {
    store,
    baseline: async (id) => plates.find((p) => p.id === id) ?? null,
    baselineAtVersion: async (_v, id) =>
      plates.find((p) => p.id === id) ?? null,
    stateBaseline: async () => plates,
    now: () => '2026-11-16',
    supersedeRun,
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
      toJSON() {},
    })
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('Review removes one field, then clears the selected plate and leaves the other plate’s draft', async () => {
  await proposeEdit(deps, editor, {
    batchId: 'shared',
    plateId: 'AK.v',
    baseRevision: plateRevision(plates[1]),
    fields: { description: 'Draft description', tags: ['draft'] },
  })
  await proposeEdit(deps, editor, {
    batchId: 'shared',
    plateId: 'AK.b',
    baseRevision: plateRevision(plates[2]),
    fields: { tags: ['navy'] },
  })
  const value = session(editor)
  value.params.set('plate', 'AK.v')
  const view = render(<Workspace value={value} page="review" />)
  fireEvent.click(await view.findByRole('button', { name: 'After' }))
  fireEvent.click(
    view.getByRole('button', { name: 'Remove description change' })
  )
  await waitFor(async () =>
    expect((await deps.store.getEdit('shared', 'AK.v'))?.fields).toEqual({
      tags: ['draft'],
    })
  )
  await waitFor(() =>
    expect(
      view.queryByRole('button', { name: 'Remove description change' })
    ).toBeNull()
  )
  fireEvent.click(view.getByRole('button', { name: 'Remove all changes' }))
  const dialog = await view.findByRole('alertdialog', {
    name: 'Remove all changes for Variant?',
  })
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Remove all changes' })
  )
  await view.findByText('No changes for this plate')
  expect(await deps.store.getEdit('shared', 'AK.v')).toBeNull()
  expect((await deps.store.getEdit('shared', 'AK.b'))?.fields).toEqual({
    tags: ['navy'],
  })
  expect((await deps.store.getBatch('shared'))?.plateIds).toEqual([
    'AK.a',
    'AK.b',
  ])
})

/**
 * Expose a reorder control that reverses the fixture state order through the real hook.
 */
function OrderAction() {
  const { reorder } = useReorderState()
  return (
    <button
      onClick={() =>
        void reorder('AK', ['AK.b', 'AK.a', 'AK.v'], {
          from: 'AK.a',
          to: 'AK.b',
        })
      }
    >
      Reverse State order
    </button>
  )
}
/** Read rendered family labels in DOM order to observe the latest draft order. */
function familyOrder(container: HTMLElement) {
  return within(container)
    .getAllByRole('article')
    .map((article) => article.getAttribute('aria-label'))
}
/**
 * Allow queued live updates and SWR refresh work to settle inside React's test boundary.
 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 70))
  })
}
/** Mount the two actor views and wait for both to load the shared batch. */
async function twoSessions() {
  const first = render(<Workspace value={session(editor)} />)
  const second = render(<Workspace value={session(owner)} />)
  await waitFor(() => expect(first.container.textContent).toContain('Live'))
  await waitFor(() =>
    expect(
      second.container
        .querySelector('[data-batch-id]')
        ?.getAttribute('data-batch-revision')
    ).toBe('0')
  )
  await settle()
  return { first, second }
}

test('State order and Standard reach the other Dashboard and the Batch can be submitted', async () => {
  const { first, second } = await twoSessions()
  expect(familyOrder(second.container)).toEqual(['Army family', 'Navy family'])
  fireEvent.click(within(first.container).getByText('Reverse State order'))
  await waitFor(() =>
    expect(
      second.container
        .querySelector('[data-batch-id]')
        ?.getAttribute('data-batch-revision')
    ).toBe('1')
  )
  expect(familyOrder(first.container)).toEqual(['Navy family', 'Army family'])
  expect(familyOrder(second.container)).toEqual(['Navy family', 'Army family'])
  expect(
    requests.find((r) => r.path.endsWith('/state-order/AK'))
  ).toMatchObject({
    path: '/api/batches/shared/state-order/AK',
    body: {
      batchRevision: 0,
      standard: { from: 'AK.a', to: 'AK.b' },
      order: ['AK.b', 'AK.a', 'AK.v'],
    },
  })
  expect(
    within(first.container).queryByRole('link', { name: 'Review Batch' })
  ).toBeNull()
  const review = render(<Workspace value={session(editor)} page="review" />)
  await within(review.container).findByRole('region', {
    name: 'Before and after',
  })
  fireEvent.click(
    await within(review.container).findByRole('button', {
      name: 'Submit for review',
    })
  )
  await waitFor(() =>
    expect(
      within(second.container)
        .getByLabelText('Selected Batch')
        .getAttribute('data-batch-revision')
    ).toBe('2')
  )
  expect(await deps.store.getBatch('shared')).toMatchObject({
    state: 'submitted',
    revision: 2,
  })
})

test('a stale State order submission changes neither draft nor signal', async () => {
  const { first, second } = await twoSessions()
  connected = false
  expect(
    await reorderState(deps, owner, {
      batchId: 'shared',
      state: 'AK',
      batchRevision: 0,
      standard: { from: 'AK.a', to: 'AK.b' },
      order: ['AK.b', 'AK.a', 'AK.v'],
    })
  ).toMatchObject({ ok: true })
  const before = await deps.store.readBatch('shared')
  fireEvent.click(within(first.container).getByText('Reverse State order'))
  await waitFor(() =>
    expect(failedOrder).toEqual({ ok: false, error: 'superseded_revision' })
  )
  expect(await deps.store.readBatch('shared')).toEqual(before)
  expect(signals.get('shared')).toBe(1)
  expect(
    second.container
      .querySelector('[data-batch-id]')
      ?.getAttribute('data-batch-revision')
  ).toBe('0')
})

test('submit, approve and a post-approval edit update both the Batch bar and actions', async () => {
  const { first, second } = await twoSessions()
  const editorReview = render(
    <Workspace value={session(editor)} page="review" />
  )
  const ownerReview = render(<Workspace value={session(owner)} page="review" />)
  await act(async () => {
    expect(
      await proposeEdit(deps, editor, {
        batchId: 'shared',
        plateId: 'AK.v',
        baseRevision: plateRevision(plates[1]),
        fields: { tags: ['first'] },
      })
    ).toMatchObject({ ok: true })
  })
  await waitFor(() =>
    expect(
      first.container
        .querySelector('[data-batch-id]')
        ?.getAttribute('data-batch-revision')
    ).toBe('1')
  )
  fireEvent.click(
    await within(editorReview.container).findByRole('button', {
      name: 'Submit for review',
    })
  )
  await waitFor(() =>
    expect(
      within(second.container)
        .getByLabelText('Selected Batch')
        .getAttribute('data-batch-revision')
    ).toBe('2')
  )
  expect(await deps.store.getBatch('shared')).toMatchObject({
    state: 'submitted',
    revision: 2,
  })
  expect(
    within(second.container)
      .getByRole('link', { name: 'Publish' })
      .getAttribute('href')
  ).toBe('/publish?batch=shared')
  expect(await deps.store.recordRun('shared', 2, 'approval-run')).toBe(true)
  const approve = await within(ownerReview.container).findByRole('button', {
    name: 'Approve revision 2',
  })
  expect(
    within(editorReview.container).queryByRole('button', {
      name: /Approve revision/,
    })
  ).toBeNull()
  fireEvent.click(approve)
  await waitFor(() =>
    expect(
      within(second.container)
        .getByLabelText('Selected Batch')
        .getAttribute('data-batch-revision')
    ).toBe('3')
  )
  expect(await deps.store.getBatch('shared')).toMatchObject({
    state: 'approved',
    revision: 3,
  })
  expect(await deps.store.getBatch('shared')).toMatchObject({
    approval: { revision: 2, by: owner.uid },
  })
  expect(
    requests.filter((request) =>
      /\/(submit|approve|publish)$/.test(request.path)
    )
  ).toEqual([
    {
      actor: editor.uid,
      method: 'POST',
      path: '/api/batches/shared/submit',
      body: { revision: 1 },
    },
    {
      actor: owner.uid,
      method: 'POST',
      path: '/api/batches/shared/approve',
      body: { revision: 2 },
    },
  ])
  await act(async () => {
    expect(
      await proposeEdit(deps, editor, {
        batchId: 'shared',
        plateId: 'AK.v',
        baseRevision: plateRevision({ ...plates[1], tags: ['first'] }),
        fields: { tags: ['revised'] },
      })
    ).toMatchObject({ ok: true })
  })
  for (const view of [first, second]) {
    await waitFor(() =>
      expect(
        view.container
          .querySelector('[data-batch-id]')
          ?.getAttribute('data-batch-revision')
      ).toBe('4')
    )
    expect(
      within(view.container).queryByRole('button', {
        name: 'Submit for review',
      })
    ).toBeNull()
  }
  expect(await deps.store.getBatch('shared')).toMatchObject({
    state: 'open',
    approval: null,
    revision: 4,
  })
  expect(supersedeRun).toHaveBeenCalledWith(
    expect.objectContaining({
      state: 'approved',
      approvalRun: { runId: 'approval-run', revision: 2 },
    })
  )
})

test('an Owner approving a stale Review sees the updated revision without approving it', async () => {
  await proposeEdit(deps, editor, {
    batchId: 'shared',
    plateId: 'AK.v',
    baseRevision: plateRevision(plates[1]),
    fields: { tags: ['first'] },
  })
  await submitBatch(deps, editor, 'shared', 1)
  // Start offline so an initial live snapshot cannot queue a catch-up read.
  connected = false
  const review = render(<Workspace value={session(owner)} page="review" />)
  const view = within(review.container)
  await view.findByRole('button', { name: 'Approve revision 2' })
  await act(async () => {
    await proposeEdit(deps, editor, {
      batchId: 'shared',
      plateId: 'AK.v',
      baseRevision: plateRevision({ ...plates[1], tags: ['first'] }),
      fields: { tags: ['revised'] },
    })
    await submitBatch(deps, editor, 'shared', 3)
  })
  expect(await deps.store.getBatch('shared')).toMatchObject({
    state: 'submitted',
    revision: 4,
  })
  fireEvent.click(view.getByRole('button', { name: 'Approve revision 2' }))
  expect(
    requests.filter((request) => request.path.endsWith('/approve'))
  ).toEqual([
    {
      actor: owner.uid,
      method: 'POST',
      path: '/api/batches/shared/approve',
      body: { revision: 2 },
    },
  ])
  await view.findByText(
    'This batch changed while you were reviewing. Look again at revision 4.'
  )
  expect(
    await view.findByRole('button', { name: 'Approve revision 4' })
  ).toBeDefined()
  expect(await deps.store.getBatch('shared')).toMatchObject({
    state: 'submitted',
    revision: 4,
    approval: null,
  })
})

test('resubscription catches up missed commits with one coherent read and ignores duplicate or older signals', async () => {
  const { second } = await twoSessions()
  connected = false
  await act(async () => {
    await reorderState(deps, editor, {
      batchId: 'shared',
      state: 'AK',
      batchRevision: 0,
      standard: { from: 'AK.a', to: 'AK.b' },
      order: ['AK.b', 'AK.a', 'AK.v'],
    })
    await submitBatch(deps, editor, 'shared', 1)
    await approveBatch(deps, owner, 'shared', 2)
  })
  const key = owner.uid + '/api/batches/shared'
  const before = reads.get(key)!
  expect(
    second.container
      .querySelector('[data-batch-id]')
      ?.getAttribute('data-batch-revision')
  ).toBe('0')
  connected = true
  await act(async () => {
    failures.get('shared')!({ code: 'permission-denied' })
  })
  await waitFor(() =>
    expect(
      second.container
        .querySelector('[data-batch-id]')
        ?.getAttribute('data-batch-revision')
    ).toBe('3')
  )
  await settle()
  expect(reads.get(key)).toBe(before + 1)
  expect(familyOrder(second.container)).toEqual(['Navy family', 'Army family'])
  expect(await deps.store.getBatch('shared')).toMatchObject({
    state: 'approved',
    revision: 3,
  })
  act(() => {
    emit('shared', 1)
    emit('shared', 2)
    emit('shared', 3)
    emit('shared', 3)
  })
  await settle()
  expect(reads.get(key)).toBe(before + 1)
})

test('manual Refresh catches up while the subscription is unavailable', async () => {
  const { second } = await twoSessions()
  act(() => {
    failures.get('shared')!({ code: 'unavailable' })
  })
  await waitFor(() =>
    expect(second.container.textContent).toContain('Live updates unavailable')
  )
  await act(async () => {
    await reorderState(deps, editor, {
      batchId: 'shared',
      state: 'AK',
      batchRevision: 0,
      standard: { from: 'AK.a', to: 'AK.b' },
      order: ['AK.b', 'AK.a', 'AK.v'],
    })
    await submitBatch(deps, editor, 'shared', 1)
  })
  const key = owner.uid + '/api/batches/shared'
  const before = reads.get(key)!
  fireEvent.click(
    within(second.container).getByRole('button', { name: 'Refresh' })
  )
  await waitFor(() =>
    expect(
      second.container
        .querySelector('[data-batch-id]')
        ?.getAttribute('data-batch-revision')
    ).toBe('2')
  )
  expect(reads.get(key)).toBe(before + 1)
  expect(familyOrder(second.container)).toEqual(['Navy family', 'Army family'])
  expect(await deps.store.getBatch('shared')).toMatchObject({
    state: 'submitted',
    revision: 2,
  })
  expect(second.container.textContent).toContain('Live updates unavailable')
})

test('a burst of committed lifecycle signals fetches only the latest coherent Batch', async () => {
  const { second } = await twoSessions()
  const key = owner.uid + '/api/batches/shared'
  const before = reads.get(key)!
  await act(async () => {
    await reorderState(deps, editor, {
      batchId: 'shared',
      state: 'AK',
      batchRevision: 0,
      standard: { from: 'AK.a', to: 'AK.b' },
      order: ['AK.b', 'AK.a', 'AK.v'],
    })
    await submitBatch(deps, editor, 'shared', 1)
    await approveBatch(deps, owner, 'shared', 2)
  })
  await waitFor(() =>
    expect(
      second.container
        .querySelector('[data-batch-id]')
        ?.getAttribute('data-batch-revision')
    ).toBe('3')
  )
  await settle()
  expect(reads.get(key)).toBe(before + 1)
  expect(familyOrder(second.container)).toEqual(['Navy family', 'Army family'])
  expect(await deps.store.getBatch('shared')).toMatchObject({
    state: 'approved',
    revision: 3,
  })
})

test('Standard plate issues offers a confirmed repair for the first Template', async () => {
  const original = (await deps.store.getBatch('shared'))!
  await deps.store.commit('shared', 0, {
    batch: {
      ...original,
      revision: 1,
      stateOrders: { AK: ['AK.b', 'AK.a', 'AK.v'] },
    },
  })
  const value = session(editor)
  value.params.set('show', 'standardPlate')
  const view = render(<Workspace value={value} />)
  await waitFor(() =>
    expect(
      view.container
        .querySelector('[data-batch-id]')
        ?.getAttribute('data-batch-revision')
    ).toBe('1')
  )
  fireEvent.click(
    within(view.container).getByRole('button', {
      name: 'Make Navy the Standard',
    })
  )
  expect(within(document.body).getByRole('alertdialog').textContent).toContain(
    'Make Navy the AK Standard?'
  )
  expect((await deps.store.getBatch('shared'))?.revision).toBe(1)
  fireEvent.click(
    within(document.body).getByRole('button', { name: 'Make Standard' })
  )
  await waitFor(async () =>
    expect(
      (await deps.store.getEdit('shared', 'AK.b'))?.fields.isStandard
    ).toBe(true)
  )
  expect((await deps.store.getEdit('shared', 'AK.a'))?.fields.isStandard).toBe(
    false
  )
})

test('Standard repair buttons exclude states absent from this Batch state orders', async () => {
  const original = (await deps.store.getBatch('shared'))!
  await deps.store.commit('shared', 0, {
    batch: { ...original, revision: 1 },
    edits: plates
      .filter((plate) => plate.id !== 'AK.v')
      .map((plate) => ({
        plateId: plate.id,
        fields: { isStandard: plate.id === 'AK.b' },
        baseRevision: '',
        resultRevision: '',
        authorId: editor.uid,
        updatedAt: '',
      })),
  })
  const value = session(editor)
  value.params.set('show', 'standardPlate')
  const view = render(<Workspace value={value} />)
  await waitFor(() =>
    expect(
      view.container
        .querySelector('[data-batch-id]')
        ?.getAttribute('data-batch-revision')
    ).toBe('1')
  )
  expect(
    within(view.container).queryByRole('button', {
      name: /Make .* the Standard/,
    })
  ).toBeNull()
  expect(requests.filter((request) => request.method === 'PATCH')).toEqual([])
})

test('the legacy submit endpoint still reports the affected state and repair instruction', async () => {
  const original = (await deps.store.getBatch('shared'))!
  await deps.store.commit('shared', 0, {
    batch: {
      ...original,
      revision: 1,
      stateOrders: { AK: ['AK.b', 'AK.a', 'AK.v'] },
    },
  })
  expect(await submitBatch(deps, editor, 'shared', 1)).toMatchObject({
    ok: false,
    error: 'standard_change_unconfirmed',
    reasons: [
      expect.stringContaining(
        'AK: use Standard plate issues to make Navy the Standard'
      ),
    ],
  })
})

test('the Owner receives a live Editor change in the exact Batch confirmation', async () => {
  const { first, second } = await twoSessions()
  expect(
    within(first.container).queryByRole('link', { name: 'Publish' })
  ).toBeNull()
  const target = within(second.container)
    .getByRole('link', { name: 'Publish' })
    .getAttribute('href')
  expect(target).toBe('/publish?batch=shared')
  const batchId = new URL(target!, 'http://localhost').searchParams.get(
    'batch'
  )!
  await act(async () => {
    expect(
      await proposeEdit(deps, editor, {
        batchId,
        plateId: 'AK.v',
        baseRevision: plateRevision(plates[1]),
        fields: { tags: ['first'] },
      })
    ).toMatchObject({ ok: true })
    await deps.store.markViewed!(batchId, owner.uid, 1, deps.now())
  })
  const view = render(
    <Workspace value={session(owner, batchId)} page="publish" />
  )
  const publish = within(view.container)
  const open = await publish.findByRole('button', { name: 'Publish to Game' })
  const dialogElement = view.container.querySelector('dialog')!
  dialogElement.showModal = () => dialogElement.setAttribute('open', '')
  dialogElement.close = () => dialogElement.removeAttribute('open')
  fireEvent.click(open)
  const dialog = within(publish.getByRole('dialog'))
  expect(
    dialog.getByRole('button', { name: 'Publish revision 1' })
  ).toBeTruthy()

  await act(async () => {
    const plate = { ...plates[1], tags: ['first'] }
    expect(
      await proposeEdit(deps, editor, {
        batchId,
        plateId: plate.id,
        baseRevision: plateRevision(plate),
        fields: { tags: ['latest'] },
      })
    ).toMatchObject({ ok: true })
  })
  expect(await dialog.findByText(/This Batch changed/)).toBeTruthy()
  expect(await dialog.findByText(/1 Plate changed.*Editor/)).toBeTruthy()
  expect(
    requests.filter((request) => request.path.endsWith('/publish'))
  ).toEqual([])
  fireEvent.click(dialog.getByRole('button', { name: 'Publish anyway' }))
  await waitFor(() =>
    expect(
      requests.filter((request) => request.path.endsWith('/publish'))
    ).toEqual([
      {
        actor: owner.uid,
        method: 'POST',
        path: '/api/batches/shared/publish',
        body: { revision: 2, commandId: expect.any(String) },
      },
    ])
  )
})
