import { createContext, useContext } from 'react'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PlatePage } from '../components/plate-page/plate-page'
import { slimPlate } from '../components/plate-page/types'
import { FamilyGrid } from '../components/dashboard/family-grid'
import { SelectedBatchBar } from '../components/dashboard/selected-batch-bar'
import { projectFamilyPlate } from '../components/dashboard/family-data'
import { LiveSignalProvider, type LiveSignalSource } from '../lib/client/live-signal'
import { ApiError } from '../lib/client/api'
import { createMemoryStore } from '../lib/review/memory-store'
import { proposeEdit, reorderState } from '../lib/review/batch'
import { batchDetail } from '../lib/review/queries'
import { respond } from '../lib/server/respond'
import { plateRevision } from '../lib/review/revision'
import type { Actor, EditableFields, ReviewBatch, ReviewDeps } from '../lib/review/types'
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
  { id: 'AK.a', state: 'AK', image: '', slug: 'a', displayName: 'Army', tags: [], templateRole: 'template', templateFamily: 'army' },
  { id: 'AK.v', state: 'AK', image: '', slug: 'v', displayName: 'Variant', tags: [], templateRole: 'variant', templateFamily: 'army', variantOfPlateId: 'AK.a' },
  { id: 'AK.b', state: 'AK', image: '', slug: 'b', displayName: 'Navy', tags: [], templateRole: 'template', templateFamily: 'navy' },
]
const cards = plates.map((plate, index) => ({ ...plateCards[0], ...plate, imageUrl: null, variantOfPlateId: plate.variantOfPlateId ?? null, isStandard: false, sortOrder: index, revision: plateRevision(plate) }))
const gridPlates = cards.map(projectFamilyPlate)
function batch(id = 'shared', actor = editor): ReviewBatch {
  return { id, name: id + ' Batch', createdBy: actor.uid, createdByName: actor.name, createdAt: '2026-11-16', state: 'open', revision: 0, baselineVersion: 1, stateOrders: {}, plateIds: plates.map(p => p.id), approval: null }
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
  subscribe(_env, id, next, error) {
    failures.set(id, error)
    const set = listeners.get(id) ?? new Set()
    listeners.set(id, set)
    set.add(next)
    if (denySignal) queueMicrotask(() => error({ code: 'permission-denied' }))
    else next(missingSignal ? null : signals.get(id) ?? null)
    return () => { set.delete(next); disposed.push(id) }
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
        if (path === '/api/jobs/tag-job') return { state: 'completed', suggestions: ['naval'], inputHash: tagRevision }
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
        if (path.endsWith('/tagging')) {
          const result = await batchDetail(deps, path.split('/')[3])
          if (!result.ok) throw new Error('Missing Batch')
          tagRevision = result.value.plates.find(p => p.proposed.id === 'AK.v')!.revision
          return { jobId: 'tag-job', runId: 'tag-workflow' }
        }
        if (method === 'PUT') {
          const result = await reorderState(deps, actor, { batchId: path.split('/')[3], state: 'AK', ...body as { batchRevision: number; order: string[]; promotion?: { plateId: string; templateFamily: string } } })
          if (!result.ok) {
            const response = respond(result)
            throw new ApiError(response.status, result.error, await response.json())
          }
          return result.value
        }
        if (method !== 'PATCH') throw new Error('Unexpected write ' + path)
        const [, , , batchId, , plateId] = path.split('/')
        const result = await proposeEdit(deps, actor, { batchId, plateId, ...body as { baseRevision: string; fields: EditableFields } })
        if (!result.ok) {
          const response = respond(result)
          throw new ApiError(response.status, result.error, await response.json())
        }
        return result.value
      },
    },
  }
}
function Page({ index = 1 }: { index?: number }) {
  return <PlatePage plate={{ ...slimPlate(cards[index]), imageSize: { width: 320, height: 160 }, description: null, sourceUrl: null, wikiUrl: null }} plates={cards.map(slimPlate)} stateName="Alaska" prevId="AK.a" nextId="AK.b" />
}
function Workspace({ actor, page = false, index = 1 }: { actor: Actor; page?: boolean; index?: number }) {
  return <Context.Provider value={session(actor)}><SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false, revalidateOnFocus: false }}><LiveSignalProvider value={source}>{page ? <Page index={index} /> : <><SelectedBatchBar /><FamilyGrid plates={gridPlates} /></>}</LiveSignalProvider></SWRConfig></Context.Provider>
}
function pointer(element: Element, type: string, x: number, y = 100) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
  act(() => { (type === 'pointerdown' ? element : window).dispatchEvent(event) })
}
function targetRects(container: HTMLElement) {
  container.querySelectorAll<HTMLElement>('[data-drag-family]').forEach(element => {
    const left = element.dataset.dragFamily === 'AK.b' ? 300 : 0
    element.getBoundingClientRect = () => ({ left, right: left + 250, top: 0, bottom: 300, width: 250, height: 300, x: left, y: 0, toJSON() {} })
  })
}
beforeEach(() => {
  failures = new Map(); missingSignal = false; denySignal = false
  requests = []; listeners = new Map(); signals = new Map([['shared', 0], ['other', 0]]); reads = new Map(); disposed = []
  const store = createMemoryStore([batch(), batch('other', owner)])
  const commit = store.commit.bind(store)
  store.commit = async (...args) => { const result = await commit(...args); if (result === 'ok') emit(args[0], args[2].batch.revision); return result }
  deps = { store, baseline: async id => plates.find(p => p.id === id) ?? null, baselineAtVersion: async (_v, id) => plates.find(p => p.id === id) ?? null, stateBaseline: async () => plates, now: () => '2026-11-16' }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, right: 1500, top: 0, bottom: 300, width: 1500, height: 300, x: 0, y: 0, toJSON() {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const box = (view: ReturnType<typeof render>, label = 'Description') => within(view.container).getByRole('textbox', { name: label }) as HTMLInputElement
const button = (view: ReturnType<typeof render>, name: string) => within(view.container).getByRole('button', { name })
async function ready(view: ReturnType<typeof render>) {
  await waitFor(() => expect(view.container.textContent).toContain('Live'))
}

test.each(['pointer', 'keyboard'] as const)('two sessions reject a stale %s promotion after order or unrelated Tag saves', async mode => {
  for (const change of ['order', 'tag'] as const) {
    const first = render(<Workspace actor={editor} />)
    const second = render(<Workspace actor={owner} />)
    await ready(first); await ready(second)
    targetRects(first.container)
    const handle = first.container.querySelector<HTMLElement>('[data-plate-row="AK.v"]')!
    if (mode === 'pointer') { pointer(handle, 'pointerdown', 100); pointer(handle, 'pointermove', 540, 100) }
    else { fireEvent.keyDown(handle, { key: ' ', shiftKey: true }); fireEvent.keyDown(window, { key: 'ArrowRight' }) }
    const order = ['AK.b', 'AK.a', 'AK.v']
    const revision = (await deps.store.getBatch('shared'))!.revision
    await act(async () => {
      if (change === 'order') expect((await reorderState(deps, owner, { batchId: 'shared', state: 'AK', batchRevision: revision, order })).ok).toBe(true)
      else await remote({ tags: ['remote tag'] }, 'AK.b')
    })
    expect(Array.from(first.container.querySelectorAll<HTMLElement>('[data-drag-family]')).map(el => el.dataset.dragFamily)).not.toEqual(['AK.b', 'AK.a'])
    if (mode === 'pointer') pointer(handle, 'pointerup', 540, 100)
    else fireEvent.keyDown(window, { key: ' ' })
    await waitFor(() => expect(first.container.textContent).toContain('This Batch changed. Drag again'))
    expect((await saved()).proposed.templateRole).toBe('variant')
    expect((await deps.store.getBatch('shared'))!.revision).toBe(revision + 1)
    expect(first.container.textContent).not.toContain('Lifted Variant')
    expect(requests.filter(r => r.method === 'PUT').at(-1)?.body).toMatchObject({ batchRevision: revision, promotion: { plateId: 'AK.v' } })
    if (change === 'order') expect((await deps.store.getBatch('shared'))!.stateOrders.AK).toEqual(order)
    if (change === 'order') expect(Array.from(first.container.querySelectorAll<HTMLElement>('[data-drag-family]')).map(el => el.dataset.dragFamily)).toEqual(['AK.b', 'AK.a'])
    if (mode === 'keyboard') await waitFor(() => expect(document.activeElement).toBe(first.container.querySelector<HTMLElement>('[data-plate-row="AK.v"]')!))
    cleanup()
  }
})

test.each(['pointer', 'keyboard'] as const)('two sessions see a successful %s promotion and order together; other Batch saves do not conflict', async mode => {
  const first = render(<Workspace actor={editor} />)
  const second = render(<Workspace actor={owner} />)
  await ready(first); await ready(second)
  targetRects(first.container)
  const handle = first.container.querySelector<HTMLElement>('[data-plate-row="AK.v"]')!
  if (mode === 'pointer') { pointer(handle, 'pointerdown', 100); pointer(handle, 'pointermove', 540) }
  else { fireEvent.keyDown(handle, { key: ' ', shiftKey: true }); fireEvent.keyDown(window, { key: 'ArrowRight' }); fireEvent.keyDown(window, { key: 'ArrowRight' }) }
  expect((await reorderState(deps, owner, { batchId: 'other', state: 'AK', batchRevision: 0, order: ['AK.b', 'AK.a', 'AK.v'] })).ok).toBe(true)
  if (mode === 'pointer') pointer(handle, 'pointerup', 540)
  else fireEvent.keyDown(window, { key: ' ' })
  await waitFor(() => expect(first.container.textContent).toContain('Dropped'))
  await waitFor(() => expect(second.container.querySelector('[data-drag-family="AK.v"]')).toBeTruthy())
  expect((await saved()).proposed).toMatchObject({ templateRole: 'template', templateFamily: 'ak_v', variantOfPlateId: null })
  expect(await deps.store.getBatch('shared')).toMatchObject({ revision: 1, stateOrders: { AK: ['AK.a', 'AK.b', 'AK.v'] } })
  for (const view of [first, second]) expect(Array.from(view.container.querySelectorAll<HTMLElement>('[data-drag-family]')).map(el => el.dataset.dragFamily)).toEqual(['AK.a', 'AK.b', 'AK.v'])
})
function input(view: ReturnType<typeof render>, value: string, label = 'Description') {
  fireEvent.change(box(view, label), { target: { value } })
}
function save(view: ReturnType<typeof render>, label = 'Description') {
  fireEvent.keyDown(box(view, label), { key: 'Enter', ctrlKey: true })
}
async function saved(plateId = 'AK.v') {
  const detail = await batchDetail(deps, 'shared')
  if (!detail.ok) throw new Error('Missing Batch')
  return detail.value.plates.find(entry => entry.proposed.id === plateId)!
}
async function remote(fields: EditableFields, plateId = 'AK.v') {
  const entry = await saved(plateId)
  await act(async () => {
    expect((await proposeEdit(deps, owner, { batchId: 'shared', plateId, baseRevision: entry.revision, fields })).ok).toBe(true)
  })
}
async function conflictPair() {
  const first = render(<Workspace actor={owner} page />)
  const second = render(<Workspace actor={editor} page />)
  await ready(first); await ready(second)
  input(second, 'My story')
  input(first, 'Saved story'); save(first)
  await waitFor(() => expect(second.container.textContent).toContain('rev 1'))
  save(second)
  await waitFor(() => expect(within(second.container).getByRole('alert').textContent).toContain('My story'))
  return { first, second }
}

test('remote update during an active drag is deferred, then applied with the original precondition and a resolvable conflict', async () => {
  const first = render(<Workspace actor={editor} />)
  const second = render(<Workspace actor={owner} page index={2} />)
  await ready(first); await ready(second)
  targetRects(first.container)
  const handle = first.container.querySelector<HTMLElement>('[data-plate-row="AK.v"]')!
  pointer(handle, 'pointerdown', 100); pointer(handle, 'pointermove', 110)
  fireEvent.click(button(second, 'Add Variant to family'))
  await waitFor(() => expect(first.container.textContent).toContain('rev 1'))
  expect(within(within(first.container).getByRole('article', { name: 'Army family' })).getByText('Variant')).toBeTruthy()
  pointer(handle, 'pointermove', 400); pointer(handle, 'pointerup', 400)
  await waitFor(() => expect(button(first, 'Reapply mine')).toBeTruthy())
  expect(within(within(first.container).getByRole('article', { name: 'Navy family' })).getByText('Variant')).toBeTruthy()
  expect(requests.filter(r => r.actor === editor.uid && r.method === 'PATCH')[0].body).toMatchObject({ baseRevision: plateRevision(plates[1]) })
  const alert = within(first.container).getByRole('alert')
  expect(alert.textContent).toContain('templateFamily')
  expect(alert.textContent).not.toContain('description')
  fireEvent.click(button(first, 'Reapply mine'))
  await waitFor(() => expect(first.container.textContent).toContain('rev 2'))
  expect((await saved()).proposed).toMatchObject({ templateFamily: 'navy', variantOfPlateId: 'AK.b' })
})

test.each(['Description', 'Template family', 'Add tag'])('remote updates preserve open %s input and its original precondition', async label => {
  const first = render(<Workspace actor={editor} page />)
  const second = render(<Workspace actor={owner} page />)
  await ready(first); await ready(second)
  input(first, 'local', label)
  input(second, 'Remote story'); save(second)
  await waitFor(() => expect(first.container.textContent).toContain('rev 1'))
  expect(box(first, label).value).toBe('local')
  save(first, label)
  await waitFor(() => expect(button(first, 'Keep saved')).toBeTruthy())
  expect(requests.filter(r => r.actor === editor.uid && r.method === 'PATCH')[0].body).toMatchObject({ baseRevision: plateRevision(plates[1]) })
  expect(within(first.container).getByRole('alert').textContent).toContain('local')
})

test('cancelling input applies the latest saved values without a write', async () => {
  const first = render(<Workspace actor={editor} page />)
  const second = render(<Workspace actor={owner} page />)
  await ready(first); await ready(second)
  input(first, 'Local story')
  input(second, 'Remote story'); save(second)
  await waitFor(() => expect(first.container.textContent).toContain('rev 1'))
  fireEvent.keyDown(box(first), { key: 'Escape' })
  expect(box(first).value).toBe('Remote story')
  expect(requests.filter(r => r.actor === editor.uid && r.method === 'PATCH')).toHaveLength(0)
})

test('different Plate saves from two sessions both succeed', async () => {
  const first = render(<Workspace actor={editor} page />)
  const second = render(<Workspace actor={owner} page index={2} />)
  await ready(first); await ready(second)
  input(first, 'Variant story'); input(second, 'Navy story')
  save(first); save(second)
  await waitFor(async () => expect((await deps.store.getBatch('shared'))?.revision).toBe(2))
  expect((await saved()).proposed.description).toBe('Variant story')
  expect((await saved('AK.b')).proposed.description).toBe('Navy story')
})

test('same Plate saves from the same revision conflict even for different fields and retain the attempted fields only', async () => {
  const first = render(<Workspace actor={editor} page />)
  const second = render(<Workspace actor={owner} page />)
  await ready(first); await ready(second)
  input(first, 'My story')
  fireEvent.click(button(second, 'Set as Standard'))
  await waitFor(() => expect(first.container.textContent).toContain('rev 1'))
  save(first)
  await waitFor(() => expect(button(first, 'Keep saved')).toBeTruthy())
  const alert = within(first.container).getByRole('alert')
  expect(alert.textContent).toContain('Proposed: My story')
  expect(alert.textContent).not.toContain('isStandard')
  expect((await saved()).proposed).toMatchObject({ isStandard: true })
  expect((await saved()).proposed.description).toBeUndefined()
})

test('Keep saved discards the proposal and leaves the saved Plate intact', async () => {
  const { second } = await conflictPair()
  fireEvent.click(button(second, 'Keep saved'))
  await waitFor(() => expect(box(second).value).toBe('Saved story'))
  expect(within(second.container).queryByRole('alert')).toBeNull()
  expect((await saved()).proposed.description).toBe('Saved story')
  expect(requests.filter(r => r.method === 'PATCH')).toHaveLength(2)
})

test('Reapply mine succeeds against the saved revision shown in the conflict', async () => {
  const { first, second } = await conflictPair()
  const revision = (await saved()).revision
  fireEvent.click(button(second, 'Reapply mine'))
  await waitFor(() => expect(box(first).value).toBe('My story'))
  await waitFor(() => expect(within(second.container).queryByRole('alert')).toBeNull())
  expect(requests.filter(r => r.method === 'PATCH').at(-1)?.body).toMatchObject({ baseRevision: revision })
  expect((await saved()).proposed.description).toBe('My story')
})

test('a third save before reapply produces another conflict with newer saved values', async () => {
  const { second } = await conflictPair()
  const reviewedRevision = (await saved()).revision
  await remote({ description: 'Third story' })
  await waitFor(() => expect(second.container.textContent).toContain('rev 2'))
  fireEvent.click(button(second, 'Reapply mine'))
  await waitFor(() => expect(within(second.container).getByRole('alert').textContent).toContain('Saved: Third story'))
  expect(within(second.container).getByRole('alert').textContent).toContain('Proposed: My story')
  expect(requests.filter(r => r.method === 'PATCH').at(-1)?.body).toMatchObject({ baseRevision: reviewedRevision })
  expect((await saved()).proposed.description).toBe('Third story')
  fireEvent.click(button(second, 'Reapply mine'))
  await waitFor(async () => expect((await saved()).proposed.description).toBe('My story'))
})

test('an unresolved conflict keeps the proposal until an explicit resolution', async () => {
  const { second } = await conflictPair()
  expect((button(second, 'Set as Standard') as HTMLButtonElement).disabled).toBe(true)
  expect((button(second, 'Template') as HTMLButtonElement).disabled).toBe(true)
  expect(box(second, 'Add tag').disabled).toBe(true)
  expect(within(second.container).getByRole('alert').textContent).toContain('Proposed: My story')
})
