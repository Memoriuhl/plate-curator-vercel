import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  LiveSignalProvider,
  useLiveRefresh,
  type LiveSignalSource,
} from '../../lib/client/live-signal'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  user: { uid: 'editor' } as { uid: string } | null,
}))
vi.mock('../../lib/client/session', () => ({
  useSession: () => ({ user: mocks.user, api: { send: mocks.send } }),
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
    active()[0].next(4)
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(refresh).toHaveBeenCalledTimes(1)
  await act(() => vi.advanceTimersByTimeAsync(2000))
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
  await act(() => vi.advanceTimersByTimeAsync(30_000))
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
