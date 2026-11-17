import { createContext, useContext } from 'react'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { BatchActions } from '../components/dashboard/batch-actions'
import { FamilyGrid } from '../components/dashboard/family-grid'
import { SelectedBatchBar } from '../components/dashboard/selected-batch-bar'
import { projectFamilyPlate } from '../components/dashboard/family-data'
import { useReorderState } from '../lib/client/hooks'
import { LiveSignalProvider, type LiveSignalSource } from '../lib/client/live-signal'
import { ApiError } from '../lib/client/api'
import { createMemoryStore } from '../lib/review/memory-store'
import { approveBatch, proposeEdit, reorderState, submitBatch } from '../lib/review/batch'
import { batchDetail } from '../lib/review/queries'
import { plateRevision } from '../lib/review/revision'
import type { Actor, ReviewBatch, ReviewDeps } from '../lib/review/types'
import type { Plate } from '../lib/catalog/types'
import { plateCards } from '../fixtures/plate-cards'

const Context = createContext<ReturnType<typeof session> | null>(null)
vi.mock('../lib/client/session', () => ({ useSession: () => useContext(Context)! }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => useContext(Context)!.params,
  usePathname: () => '/states/AK',
  useRouter: () => ({ prefetch: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('next/link', () => ({ default: ({ prefetch, ...props }: Record<string, unknown>) => { void prefetch; return <a {...props} /> } }))
vi.mock('next/image', () => ({ default: () => <span /> }))
vi.mock('../components/dashboard/use-grid-entrance', () => ({ useGridEntrance: () => {} }))
vi.mock('../components/dashboard/use-drag-flip', () => ({ useDragFlip: () => {} }))
vi.mock('@tanstack/react-virtual', () => ({ useWindowVirtualizer: () => ({
  getVirtualItems: () => [{ key: 0, index: 0, start: 420 }], getTotalSize: () => 600,
  measureElement: () => {}, scrollToIndex: () => {},
}) }))

const editor: Actor = { uid: 'editor-uid', name: 'Editor', role: 'editor' }
const owner: Actor = { uid: 'owner-uid', name: 'Owner', role: 'owner' }
const plates: Plate[] = [
  { id: 'AK.a', state: 'AK', image: '', slug: 'a', displayName: 'Army', isStandard: true, tags: [], templateRole: 'template', templateFamily: 'army' },
  { id: 'AK.v', state: 'AK', image: '', slug: 'v', displayName: 'Variant', tags: [], templateRole: 'variant', templateFamily: 'army', variantOfPlateId: 'AK.a' },
  { id: 'AK.b', state: 'AK', image: '', slug: 'b', displayName: 'Navy', tags: [], templateRole: 'template', templateFamily: 'navy' },
]
const cards = plates.map((plate, index) => ({ ...plateCards[0], ...plate, imageUrl: null, variantOfPlateId: plate.variantOfPlateId ?? null, isStandard: plate.isStandard ?? false, sortOrder: index, revision: plateRevision(plate) }))
const gridPlates = cards.map(projectFamilyPlate)
function batch(id = 'shared', actor = editor): ReviewBatch {
  return { id, name: id + ' Batch', createdBy: actor.uid, createdByName: actor.name, createdAt: '2026-11-16', state: 'open', revision: 0, baselineVersion: 1, stateOrders: {}, plateIds: plates.map(p => p.id), approval: null }
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
  subscribe(_env, id, next, error) {
    failures.set(id, error)
    const set = listeners.get(id) ?? new Set()
    listeners.set(id, set)
    set.add(next)
    next(signals.get(id) ?? null)
    return () => { set.delete(next) }
  },
}
function emit(id: string, revision: number) {
  signals.set(id, revision)
  listeners.get(id)?.forEach(next => next(revision))
}
function session(actor: Actor, id: string | null = 'shared') {
  return {
    user: { uid: actor.uid }, params: new URLSearchParams(id === null ? '' : 'batch=' + id),
    api: {
      get: async (path: string) => {
        reads.set(actor.uid + path, (reads.get(actor.uid + path) ?? 0) + 1)
        if (path === '/api/me') return actor
        if (path.startsWith('/api/batches?')) return (await deps.store.list({ states: ['open'] })).filter(b => b.createdBy === actor.uid)
        if (path.startsWith('/api/batches/')) {
          const result = await batchDetail(deps, path.split('/')[3])
          if (!result.ok) throw new ApiError(404, result.error, {})
          return result.value
        }
        throw new Error(path)
      },
      send: async (method: string, path: string, body: unknown) => {
        requests.push({ actor: actor.uid, method, path, body })
        if (path === '/api/live-access') return { envKey: 'test', expiresAt: new Date(Date.now() + 3600000).toISOString() }
        if (method === 'PATCH') {
          const result = await proposeEdit(deps, actor, { batchId: path.split('/')[3], plateId: path.split('/')[5], ...body as { baseRevision: string; fields: import('../lib/review/types').EditableFields; standard?: import('../lib/review/types').StandardChange } })
          if (!result.ok) throw new ApiError(409, result.error, result)
          return result.value
        }
        if (path.endsWith('/state-order/AK') || path.endsWith('/submit')) {
          const result = path.endsWith('/state-order/AK')
            ? await reorderState(deps, actor, { batchId: path.split('/')[3], state: 'AK', ...body as { batchRevision: number; order: string[] } })
            : await submitBatch(deps, actor, path.split('/')[3], (body as { revision: number }).revision)
          if (!result.ok) { failedOrder = result; throw new ApiError(409, result.error, result) }
          return result.value
        }
        throw new Error('Unexpected write ' + method + ' ' + path)
      },
    },
  }
}
function Workspace({ value }: { value: ReturnType<typeof session> }) {
  const cache = new Map()
  return <Context.Provider value={value}><SWRConfig value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false, revalidateOnFocus: false }}><LiveSignalProvider value={source}><SelectedBatchBar /><FamilyGrid plates={gridPlates} /><OrderAction /><BatchActions underTagged={[]} stateCode="AK" stateName="Alaska" /></LiveSignalProvider></SWRConfig></Context.Provider>
}
beforeEach(() => {
  connected = true; failedOrder = undefined; supersedeRun.mockClear()
  failures = new Map()
  requests = []; listeners = new Map(); signals = new Map([['shared', 0]]); reads = new Map();
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
  deps = { store, baseline: async id => plates.find(p => p.id === id) ?? null, baselineAtVersion: async (_v, id) => plates.find(p => p.id === id) ?? null, stateBaseline: async () => plates, now: () => '2026-11-16', supersedeRun }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, right: 1500, top: 0, bottom: 300, width: 1500, height: 300, x: 0, y: 0, toJSON() {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function OrderAction() {
  const { reorder } = useReorderState()
  return <button onClick={() => void reorder('AK', ['AK.b', 'AK.a', 'AK.v'], { from: 'AK.a', to: 'AK.b' })}>Reverse State order</button>
}
function familyOrder(container: HTMLElement) {
  return within(container).getAllByRole('article').map(article => article.getAttribute('aria-label'))
}
async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 70)) })
}
async function twoSessions() {
  const first = render(<Workspace value={session(editor)} />)
  const second = render(<Workspace value={session(owner)} />)
  await waitFor(() => expect(first.container.textContent).toContain('Live'))
  await waitFor(() => expect(second.container.textContent).toContain('rev 0'))
  await settle()
  return { first, second }
}

test('State order and Standard reach the other Dashboard and the Batch can be submitted', async () => {
  const { first, second } = await twoSessions()
  expect(familyOrder(second.container)).toEqual(['Army family', 'Navy family'])
  fireEvent.click(within(first.container).getByText('Reverse State order'))
  await waitFor(() => expect(second.container.textContent).toContain('rev 1'))
  expect(familyOrder(first.container)).toEqual(['Navy family', 'Army family'])
  expect(familyOrder(second.container)).toEqual(['Navy family', 'Army family'])
  expect(requests.find(r => r.path.endsWith('/state-order/AK'))).toMatchObject({ path: '/api/batches/shared/state-order/AK', body: { batchRevision: 0, standard: { from: 'AK.a', to: 'AK.b' }, order: ['AK.b', 'AK.a', 'AK.v'] } })
  const submit = within(first.container).getByRole('button', { name: 'Submit for review' }) as HTMLButtonElement
  expect(submit.disabled).toBe(false)
  fireEvent.click(submit)
  await waitFor(() => expect(second.container.textContent).toContain('submitted'))
})

test('a stale State order submission changes neither draft nor signal', async () => {
  const { first, second } = await twoSessions()
  connected = false
  expect(await reorderState(deps, owner, { batchId: 'shared', state: 'AK', batchRevision: 0, standard: { from: 'AK.a', to: 'AK.b' }, order: ['AK.b', 'AK.a', 'AK.v'] })).toMatchObject({ ok: true })
  const before = await deps.store.readBatch('shared')
  fireEvent.click(within(first.container).getByText('Reverse State order'))
  await waitFor(() => expect(failedOrder).toEqual({ ok: false, error: 'superseded_revision' }))
  expect(await deps.store.readBatch('shared')).toEqual(before)
  expect(signals.get('shared')).toBe(1)
  expect(second.container.textContent).toContain('rev 0')
})

test('submit, approve and a post-approval edit update both the Batch bar and actions', async () => {
  const { first, second } = await twoSessions()
  await act(async () => { expect(await proposeEdit(deps, editor, { batchId: 'shared', plateId: 'AK.v', baseRevision: plateRevision(plates[1]), fields: { tags: ['first'] } })).toMatchObject({ ok: true }) })
  await waitFor(() => expect(first.container.textContent).toContain('rev 1'))
  fireEvent.click(within(first.container).getByRole('button', { name: 'Submit for review' }))
  await waitFor(() => expect(within(second.container).getByLabelText('Selected Batch').textContent).toContain('submitted'))
  expect(within(second.container).getByLabelText('AK batch actions').textContent).toContain('submitted')
  expect((within(second.container).getByRole('button', { name: 'Submit for review' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => {
    expect(await deps.store.recordRun('shared', 2, 'approval-run')).toBe(true)
    expect(await approveBatch(deps, owner, 'shared', 2)).toMatchObject({ ok: true })
  })
  await waitFor(() => expect(within(second.container).getByLabelText('Selected Batch').textContent).toContain('approved'))
  expect(within(second.container).getByLabelText('AK batch actions').textContent).toContain('approved')
  await act(async () => { expect(await proposeEdit(deps, editor, { batchId: 'shared', plateId: 'AK.v', baseRevision: plateRevision({ ...plates[1], tags: ['first'] }), fields: { tags: ['revised'] } })).toMatchObject({ ok: true }) })
  for (const view of [first, second]) {
    await waitFor(() => expect(view.container.textContent).toContain('rev 4'))
    expect(within(view.container).getByLabelText('Selected Batch').textContent).toContain('open')
    expect(within(view.container).getByLabelText('AK batch actions').textContent).toContain('open')
    expect((within(view.container).getByRole('button', { name: 'Submit for review' }) as HTMLButtonElement).disabled).toBe(false)
  }
  expect(await deps.store.getBatch('shared')).toMatchObject({ state: 'open', approval: null, revision: 4 })
  expect(supersedeRun).toHaveBeenCalledWith(expect.objectContaining({ state: 'approved', approvalRun: { runId: 'approval-run', revision: 2 } }))
})

test('resubscription catches up missed commits with one coherent read and ignores duplicate or older signals', async () => {
  const { second } = await twoSessions()
  connected = false
  await act(async () => {
    await reorderState(deps, editor, { batchId: 'shared', state: 'AK', batchRevision: 0, standard: { from: 'AK.a', to: 'AK.b' }, order: ['AK.b', 'AK.a', 'AK.v'] })
    await submitBatch(deps, editor, 'shared', 1)
    await approveBatch(deps, owner, 'shared', 2)
  })
  const key = owner.uid + '/api/batches/shared'
  const before = reads.get(key)!
  expect(second.container.textContent).toContain('rev 0')
  await act(async () => { failures.get('shared')!({ code: 'permission-denied' }) })
  await waitFor(() => expect(second.container.textContent).toContain('rev 3'))
  await settle()
  expect(reads.get(key)).toBe(before + 1)
  expect(familyOrder(second.container)).toEqual(['Navy family', 'Army family'])
  expect(within(second.container).getByLabelText('Selected Batch').textContent).toContain('approved')
  act(() => { emit('shared', 1); emit('shared', 2); emit('shared', 3); emit('shared', 3) })
  await settle()
  expect(reads.get(key)).toBe(before + 1)
})

test('manual Refresh catches up while the subscription is unavailable', async () => {
  const { second } = await twoSessions()
  act(() => { failures.get('shared')!({ code: 'unavailable' }) })
  await waitFor(() => expect(second.container.textContent).toContain('Live updates unavailable'))
  await act(async () => {
    await reorderState(deps, editor, { batchId: 'shared', state: 'AK', batchRevision: 0, standard: { from: 'AK.a', to: 'AK.b' }, order: ['AK.b', 'AK.a', 'AK.v'] })
    await submitBatch(deps, editor, 'shared', 1)
  })
  const key = owner.uid + '/api/batches/shared'
  const before = reads.get(key)!
  fireEvent.click(within(second.container).getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(second.container.textContent).toContain('rev 2'))
  expect(reads.get(key)).toBe(before + 1)
  expect(familyOrder(second.container)).toEqual(['Navy family', 'Army family'])
  expect(second.container.textContent).toContain('submitted')
  expect(second.container.textContent).toContain('Live updates unavailable')
})

test('a burst of committed lifecycle signals fetches only the latest coherent Batch', async () => {
  const { second } = await twoSessions()
  const key = owner.uid + '/api/batches/shared'
  const before = reads.get(key)!
  await act(async () => {
    await reorderState(deps, editor, { batchId: 'shared', state: 'AK', batchRevision: 0, standard: { from: 'AK.a', to: 'AK.b' }, order: ['AK.b', 'AK.a', 'AK.v'] })
    await submitBatch(deps, editor, 'shared', 1)
    await approveBatch(deps, owner, 'shared', 2)
  })
  await waitFor(() => expect(second.container.textContent).toContain('rev 3'))
  await settle()
  expect(reads.get(key)).toBe(before + 1)
  expect(familyOrder(second.container)).toEqual(['Navy family', 'Army family'])
  expect(within(second.container).getByLabelText('Selected Batch').textContent).toContain('approved')
})

test('Standard plate issues offers a confirmed repair for the first Template', async () => {
  const original = (await deps.store.getBatch('shared'))!
  await deps.store.commit('shared', 0, { batch: { ...original, revision: 1, stateOrders: { AK: ['AK.b', 'AK.a', 'AK.v'] } } })
  const value = session(editor)
  value.params.set('show', 'standardPlate')
  const view = render(<Workspace value={value} />)
  await waitFor(() => expect(view.container.textContent).toContain('rev 1'))
  fireEvent.click(within(view.container).getByRole('button', { name: 'Make Navy the Standard' }))
  expect(within(document.body).getByRole('alertdialog').textContent).toContain('Make Navy the AK Standard?')
  expect((await deps.store.getBatch('shared'))?.revision).toBe(1)
  fireEvent.click(within(document.body).getByRole('button', { name: 'Make Standard' }))
  await waitFor(async () => expect((await deps.store.getEdit('shared', 'AK.b'))?.fields.isStandard).toBe(true))
  expect((await deps.store.getEdit('shared', 'AK.a'))?.fields.isStandard).toBe(false)
})
