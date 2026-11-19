import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SWRConfig, type State } from 'swr'
import { useLatestEnhancement } from '../../components/plate/plate-image-preview'
import { useDashboardDraft, useRunRevertTarget } from '../../lib/client/hooks'
import {
  LiveSignalProvider,
  useLiveRefresh,
  type LiveSignalSource,
} from '../../lib/client/live-signal'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  get: vi.fn(),
  user: { uid: 'editor' } as { uid: string } | null,
}))
vi.mock('../../lib/client/session', () => ({
  useSession: () => ({
    user: mocks.user,
    api: { send: mocks.send, get: mocks.get },
  }),
}))

type Listener = {
  id: string
  next: (revision: number | null) => void
  error: (error: { code?: string }) => void
  stopped: boolean
}

let listeners: Listener[]
let source: LiveSignalSource
let visibility: DocumentVisibilityState

const active = (id = 'topic:pipeline') =>
  listeners.filter((listener) => listener.id === id && !listener.stopped)

function setVisibility(next: DocumentVisibilityState) {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}

function render(refresh: () => unknown, enabled = true) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LiveSignalProvider value={source}>{children}</LiveSignalProvider>
  )
  return renderHook(() => useLiveRefresh(['pipeline'], refresh, { enabled }), {
    wrapper,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  listeners = []
  mocks.user = { uid: 'editor' }
  mocks.send.mockReset()
  mocks.send.mockImplementation(async () => ({
    envKey: 'development',
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  }))
  // A fresh source per test gives each test its own hub.
  source = {
    subscribe(_envKey, id, next, error) {
      const listener = { id, next, error, stopped: false }
      listeners.push(listener)
      return () => {
        listener.stopped = true
      }
    },
  }
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

test('refetches on a change signal instead of polling', async () => {
  const refresh = vi.fn()
  const view = render(refresh)
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(mocks.send).toHaveBeenCalledWith('POST', '/api/live-access', {})

  await act(async () => {
    active()[0].next(2)
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(view.result.current).toBe('live')
  // One catch-up refresh after the first snapshot, and no polling after it.
  expect(refresh).toHaveBeenCalledTimes(1)
  refresh.mockClear()

  await act(async () => {
    active()[0].next(3)
    await vi.advanceTimersByTimeAsync(500)
    active()[0].next(4)
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(refresh).toHaveBeenCalledTimes(1)
  await act(() => vi.advanceTimersByTimeAsync(1500))
  expect(refresh).toHaveBeenCalledTimes(2)
})

test('stops listening while the tab is hidden and catches up when shown', async () => {
  const refresh = vi.fn()
  render(refresh)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
    active()[0].next(1)
    await vi.advanceTimersByTimeAsync(5000)
  })
  refresh.mockClear()

  act(() => setVisibility('hidden'))
  expect(active()).toHaveLength(0)

  await act(async () => {
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(active()).toHaveLength(1)
  await act(async () => {
    active()[0].next(2)
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(refresh).toHaveBeenCalledTimes(1)
})

test('reports unavailable and polls slowly after the listener fails', async () => {
  const refresh = vi.fn()
  const view = render(refresh)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
    active()[0].error({ code: 'unavailable' })
  })
  expect(view.result.current).toBe('unavailable')
  // The poll's round runs in the next task.
  await act(() => vi.advanceTimersByTimeAsync(30_001))
  expect(refresh).toHaveBeenCalledTimes(1)
})

test('does nothing while disabled or signed out', async () => {
  render(vi.fn(), false)
  mocks.user = null
  render(vi.fn())
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(mocks.send).not.toHaveBeenCalled()
  expect(listeners).toHaveLength(0)
})

test('a view that turns active changes its safety refresh without listening again', async () => {
  const refresh = vi.fn()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LiveSignalProvider value={source}>{children}</LiveSignalProvider>
  )
  const view = renderHook(
    ({ safetyMs }: { safetyMs?: number }) =>
      useLiveRefresh(['publish'], refresh, { safetyMs, key: 'run' }),
    { wrapper, initialProps: {} }
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
    active('topic:publish')[0].next(1)
    await vi.advanceTimersByTimeAsync(60_000)
  })
  // Idle: one catch-up read, then nothing without a signal.
  expect(refresh).toHaveBeenCalledTimes(1)

  view.rerender({ safetyMs: 5000 })
  await act(() => vi.advanceTimersByTimeAsync(10_001))
  expect(refresh).toHaveBeenCalledTimes(3)
  view.rerender({})
  await act(() => vi.advanceTimersByTimeAsync(60_000))
  expect(refresh).toHaveBeenCalledTimes(3)
  expect(listeners).toHaveLength(1)
  expect(mocks.send).toHaveBeenCalledTimes(1)
})

test('an open image preview picks up a finished enhancement whose signal was lost', async () => {
  vi.stubEnv('NEXT_PUBLIC_LOCAL_PIPELINE', '1')
  try {
    let result: unknown = null
    mocks.get.mockImplementation(async () => ({ result }))
    const cache = new Map()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
        <LiveSignalProvider value={source}>{children}</LiveSignalProvider>
      </SWRConfig>
    )
    const view = renderHook(() => useLatestEnhancement('AK.one', true), {
      wrapper,
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      active()[0].next(1)
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(view.result.current).toBeNull()

    // The enhancement job commits, but its pipeline bump fails; the listener stays healthy.
    result = { jobId: 'job', suggestion: { image: 'after.webp' } }
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(view.result.current).toEqual(result)
  } finally {
    vi.unstubAllEnvs()
  }
})

test('a view with a ten-minute safety refresh stays quiet while live, and polls every 30 seconds once its listener fails', async () => {
  const refresh = vi.fn()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <LiveSignalProvider value={source}>{children}</LiveSignalProvider>
  )
  renderHook(
    () =>
      useLiveRefresh(['pipeline'], refresh, {
        key: 'idle-list',
        safetyMs: 600_000,
      }),
    { wrapper }
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
    active()[0].next(1)
    await vi.advanceTimersByTimeAsync(2001)
  })
  // The first snapshot's catch-up read, then nothing for minutes while healthy.
  expect(refresh).toHaveBeenCalledTimes(1)
  await act(() => vi.advanceTimersByTimeAsync(5 * 60_000))
  expect(refresh).toHaveBeenCalledTimes(1)
  await act(async () => {
    active()[0].error({ code: 'unavailable' })
    await vi.advanceTimersByTimeAsync(60_001)
  })
  expect(refresh).toHaveBeenCalledTimes(3)
})

test('an unresolved run revert target waits for a pipeline signal', async () => {
  let target: unknown = null
  mocks.get.mockReset().mockImplementation(async () => target)
  const cache = new Map([
    ['/api/local-pipeline/runs/run/revert', { data: null }],
  ])
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
      <LiveSignalProvider value={source}>{children}</LiveSignalProvider>
    </SWRConfig>
  )
  const view = renderHook(() => useRunRevertTarget('run'), { wrapper })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
    active()[0]?.next(1)
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(view.result.current.data).toBeNull()
  const initialReads = mocks.get.mock.calls.length
  await act(() => vi.advanceTimersByTimeAsync(12_000))
  expect(mocks.get).toHaveBeenCalledTimes(initialReads)

  target = { runId: 'run', attempt: 1, jobIds: ['job'] }
  await act(async () => {
    active()[0].next(2)
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(view.result.current.data).toEqual(target)
})

test('the Dashboard recovers dropped state bumps on resume and at the visible safety interval', async () => {
  const path = '/api/batches?dashboard=AK&catalogVersion=1'
  const id = 'shared-draft-development'
  let revision = 1
  const draft = () => ({
    draft: { batch: { id, revision, baselineVersion: 1 }, plates: [] },
  })
  const cache = new Map<string, State>([
    ['/api/me', { data: { draftId: id } }],
    [path, { data: draft() }],
  ])
  mocks.get.mockReset().mockImplementation(async (url: string) => {
    if (url === '/api/me') return { draftId: id }
    if (url === path) return draft()
    throw new Error(`Unexpected request: ${url}`)
  })
  const stateReads = () => mocks.get.mock.calls.filter(([url]) => url === path)
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
      <LiveSignalProvider value={source}>{children}</LiveSignalProvider>
    </SWRConfig>
  )
  const view = renderHook(() => useDashboardDraft('AK', 1), { wrapper })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
    active('topic:draft:AK')[0].next(1)
    await vi.advanceTimersByTimeAsync(2001)
  })
  expect(view.result.current?.draft.batch.revision).toBe(1)

  act(() => setVisibility('hidden'))
  revision = 2
  mocks.get.mockClear()
  await act(() => vi.advanceTimersByTimeAsync(600_000))
  expect(stateReads()).toHaveLength(0)
  await act(async () => {
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(0)
    active('topic:draft:AK')[0].next(1)
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(view.result.current?.draft.batch.revision).toBe(2)
  expect(stateReads()).toHaveLength(1)

  revision = 3
  mocks.get.mockClear()
  await act(() => vi.advanceTimersByTimeAsync(599_998))
  expect(stateReads()).toHaveLength(0)
  await act(() => vi.advanceTimersByTimeAsync(2))
  expect(stateReads()).toHaveLength(1)
  expect(view.result.current?.draft.batch.revision).toBe(3)
})

test('the Dashboard catches up on its own state and an older request cannot replace it', async () => {
  const key = (state: string) =>
    `/api/batches?dashboard=${state}&catalogVersion=1`
  const draft = (revision: number) => ({
    draft: {
      batch: { id: 'shared-draft-development', revision, baselineVersion: 1 },
      plates: [],
    },
  })
  const cache = new Map<string, State>([
    ['/api/me', { data: { draftId: 'shared-draft-development' } }],
    [key('AL'), { data: draft(1) }],
    [key('AK'), { data: draft(1) }],
  ])
  const slow = Promise.withResolvers<ReturnType<typeof draft>>()
  let al = 1
  mocks.get.mockReset().mockImplementation((url: string) => {
    if (url === '/api/me')
      return Promise.resolve({ draftId: 'shared-draft-development' })
    if (url === key('AK')) return Promise.resolve(draft(1))
    if (url === key('AL'))
      return al === 2 ? slow.promise : Promise.resolve(draft(al))
    throw new Error(`Unexpected request: ${url}`)
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
      <LiveSignalProvider value={source}>{children}</LiveSignalProvider>
    </SWRConfig>
  )
  const view = renderHook(
    () => ({
      al: useDashboardDraft('AL', 1),
      ak: useDashboardDraft('AK', 1),
    }),
    { wrapper }
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
    active('topic:draft:AL')[0].next(1)
    active('topic:draft:AK')[0].next(1)
    await vi.advanceTimersByTimeAsync(2001)
  })
  expect(view.result.current.al?.draft.batch.revision).toBe(1)
  mocks.get.mockClear()
  al = 2
  await act(async () => {
    active('topic:draft:AL')[0].next(2)
    await vi.advanceTimersByTimeAsync(2000)
  })
  al = 3
  await act(async () => {
    active('topic:draft:AL')[0].next(3)
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(view.result.current.al?.draft.batch.revision).toBe(3)
  expect(view.result.current.ak?.draft.batch.revision).toBe(1)
  expect(mocks.get.mock.calls).toEqual([[key('AL')], [key('AL')]])
  await act(async () => {
    slow.resolve(draft(2))
  })
  expect(view.result.current.al?.draft.batch.revision).toBe(3)

  act(() => setVisibility('hidden'))
  expect(active('topic:draft:AL')).toHaveLength(0)
  al = 4
  mocks.get.mockClear()
  await act(() => vi.advanceTimersByTimeAsync(12_000))
  expect(mocks.get).not.toHaveBeenCalled()
  await act(async () => {
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(0)
    active('topic:draft:AK')[0].next(1)
    active('topic:draft:AL')[0].next(4)
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(
    mocks.get.mock.calls
      .filter(([url]) => url.startsWith('/api/batches'))
      .map(([url]) => url)
      .sort()
  ).toEqual([key('AK'), key('AL')])
  expect(view.result.current.al?.draft.batch.revision).toBe(4)
})
