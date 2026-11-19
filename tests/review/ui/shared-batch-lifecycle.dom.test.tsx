import { moveState } from '../../../lib/review/move-state'
import type { StateMove } from '../../../lib/review/state-move'
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
import { PublishWorkspace } from '../../../components/publish/workspace'
import { ReviewWorkspace } from '../../../components/review/workspace'
import { BatchActions } from '../../../components/dashboard/selection/batch-actions'
import { DashboardPipelineProvider } from '../../../components/dashboard/pipeline-runs/pipeline-runs'
import { FamilyGrid } from '../../../components/dashboard/family-grid/family-grid'
import { SelectedBatchBar } from '../../../components/dashboard/selection/selected-batch-bar'
import { projectFamilyPlate } from '../../../components/dashboard/family-grid/family-data'
import { useReorderState } from '../../../lib/client/hooks'
import {
  LiveSignalProvider,
  type LiveSignalSource,
} from '../../../lib/client/live-signal'
import { ApiError } from '../../../lib/client/api'
import { createMemoryStore } from '../../../lib/review/memory-store'
import { proposeEdit, reorderState } from '../../../lib/review/batches/batch'
import { approveBatch, submitBatch } from '../../helpers/legacy-approval'
import { discardPlateChanges } from '../../../lib/review/discard-changes'
import { batchDetail } from '../../../lib/review/queries'
import { plateRevision } from '../../../lib/review/draft/revision'
import type {
  Actor,
  DraftChangeTarget,
  ReviewBatch,
  ReviewDeps,
} from '../../../lib/review/types'
import type { Plate } from '../../../lib/catalog/types'
import { plateCards } from '../../../fixtures/plate-cards'

const Context = createContext<ReturnType<typeof session> | null>(null)
vi.mock('../../../lib/client/session', () => ({
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
vi.mock('../../../components/dashboard/family-grid/use-grid-entrance', () => ({
  useGridEntrance: () => {},
}))
vi.mock('../../../components/dashboard/drag/use-drag-flip', () => ({
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
let deps: ReviewDeps
let listeners: Map<string, Set<(revision: number | null) => void>>
let signals: Map<string, number>
let requests: { actor: string; method: string; path: string; body: unknown }[]
let reads: Map<string, number>
let failures: Map<string, (error: { code?: string }) => void>
let connected: boolean
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
        if (path === '/api/me') return { ...actor, draftId: 'shared' }
        if (path === '/api/publish/control') return { control: null }
        if (path.endsWith('/run'))
          return { phase: null, runId: null, outcome: null, updatedAt: null }
        if (path.endsWith('/publish')) {
          // The Owner's Publish view of the shared draft, summarized from its detail.
          const detail = await batchDetail(deps, path.split('/')[3])
          if (!detail.ok) throw new ApiError(404, detail.error, {})
          const changed = detail.value.plates.filter(
            (entry) => entry.edit && Object.keys(entry.edit.fields).length
          )
          return {
            error: null,
            enabledHere: true,
            draftId: detail.value.batch.id,
            draftRevision: detail.value.batch.revision,
            baselineVersion: detail.value.batch.baselineVersion,
            destination: 'license-plate-game-staging',
            states: changed.length
              ? [
                  {
                    state: 'AK',
                    plates: changed.length,
                    moved: 0,
                    contributors: [
                      ...new Set(
                        changed.map(
                          (entry) =>
                            entry.edit!.authorName ?? entry.edit!.authorId
                        )
                      ),
                    ],
                  },
                ]
              : [],
            pipeline: { busy: false, activeRuns: 0 },
            approvalProblems: [],
            canPublish: changed.length > 0,
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
              fields: import('../../../lib/review/types').EditableFields
              standard?: import('../../../lib/review/types').StandardChange
            }),
          })
          if (!result.ok) throw new ApiError(409, result.error, result)
          return result.value
        }
        if (path.endsWith('/state-order/AK') || path.endsWith('/submit')) {
          const result = path.endsWith('/state-order/AK')
            ? await moveState(deps, actor, {
                batchId: path.split('/')[3],
                state: 'AK',
                ...(body as { operationId: string; moves: StateMove[] }),
              })
            : await submitBatch(
                deps,
                actor,
                path.split('/')[3],
                (body as { revision: number }).revision
              )
          if (!result.ok) {
            throw new ApiError(409, result.error, result)
          }
          return 'batch' in result.value ? result.value.batch : result.value
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
        void reorder(
          'AK',
          ['AK.b', 'AK.a', 'AK.v'],
          {
            from: 'AK.a',
            to: 'AK.b',
          },
          [
            {
              plateIds: ['AK.b'],
              placement: { kind: 'before', anchorId: 'AK.a' },
            },
          ]
        )
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

test('State order and Standard reach the other Dashboard and appear in Review without a Submit step', async () => {
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
      standard: { from: 'AK.a', to: 'AK.b' },
      moves: [
        { plateIds: ['AK.b'], placement: { kind: 'before', anchorId: 'AK.a' } },
      ],
    },
  })
  expect(
    within(first.container).queryByRole('link', { name: 'Review Batch' })
  ).toBeNull()
  const review = render(<Workspace value={session(editor)} page="review" />)
  await within(review.container).findByRole('region', {
    name: 'Before and after',
  })
  expect(
    within(review.container).queryByRole('button', {
      name: 'Submit for review',
    })
  ).toBeNull()
  expect(await deps.store.getBatch('shared')).toMatchObject({
    state: 'open',
    revision: 1,
  })
})

test('repeating an already applied placement changes neither draft nor signal', async () => {
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
    expect(
      first.container
        .querySelector('[data-batch-id]')
        ?.getAttribute('data-batch-revision')
    ).toBe('1')
  )
  expect(await deps.store.readBatch('shared')).toEqual(before)
  expect(signals.get('shared')).toBe(1)
  expect(
    second.container
      .querySelector('[data-batch-id]')
      ?.getAttribute('data-batch-revision')
  ).toBe('0')
})

test('Review has no Submit or Approve step and only the Owner is pointed at Publish', async () => {
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
  for (const view of [first, second])
    await waitFor(() =>
      expect(
        view.container
          .querySelector('[data-batch-id]')
          ?.getAttribute('data-batch-revision')
      ).toBe('1')
    )
  for (const review of [editorReview, ownerReview]) {
    await within(review.container).findByText(
      'Shared draft · unpublished changes from every curator.'
    )
    expect(
      within(review.container).queryByRole('button', {
        name: /Submit for review|Approve revision/,
      })
    ).toBeNull()
  }
  expect(
    within(ownerReview.container)
      .getByRole('link', { name: 'Publish the draft' })
      .getAttribute('href')
  ).toBe('/publish')
  expect(
    within(editorReview.container).queryByRole('link', {
      name: 'Publish the draft',
    })
  ).toBeNull()
  expect(
    requests.filter((request) => /\/(submit|approve)$/.test(request.path))
  ).toEqual([])
  expect(await deps.store.getBatch('shared')).toMatchObject({
    state: 'open',
    approval: null,
    revision: 1,
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

test('the Owner publishes the draft revision on screen while an Editor keeps editing', async () => {
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
  })
  const view = render(
    <Workspace value={session(owner, batchId)} page="publish" />
  )
  const publish = within(view.container)
  const open = await publish.findByRole('button', {
    name: 'Publish revision 1',
  })
  await waitFor(() =>
    expect(
      publish.getByRole('complementary', { name: 'Publish summary' })
        .textContent
    ).toContain('Editor · 1 plate')
  )
  expect(publish.getByLabelText('Changed by Editor')).toBeTruthy()
  const dialogElement = view.container.querySelector('dialog')!
  dialogElement.showModal = () => dialogElement.setAttribute('open', '')
  dialogElement.close = () => dialogElement.removeAttribute('open')
  fireEvent.click(open)
  const dialog = within(publish.getByRole('dialog'))
  expect(dialog.getByText('Publish revision 1?')).toBeTruthy()

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
  fireEvent.click(
    within(
      publish.getByRole('navigation', { name: 'Draft actions' })
    ).getByRole('button', { name: 'Refresh' })
  )
  expect(
    await dialog.findByText(
      /The draft moved to revision 2 since you opened this/
    )
  ).toBeTruthy()
  expect(
    requests.filter((request) => request.path.endsWith('/publish'))
  ).toEqual([])
  fireEvent.click(dialog.getByRole('button', { name: 'Publish revision 1' }))
  await waitFor(() =>
    expect(
      requests.filter((request) => request.path.endsWith('/publish'))
    ).toEqual([
      {
        actor: owner.uid,
        method: 'POST',
        path: '/api/batches/shared/publish',
        body: { revision: 1, commandId: expect.any(String) },
      },
    ])
  )
})
