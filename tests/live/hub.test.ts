import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  createLiveHub,
  type LiveGrant,
  type LiveSignalSource,
  type LiveStatus,
} from '../../lib/client/live-hub'

type Listener = {
  envKey: string
  id: string
  next: (revision: number | null) => void
  error: (error: { code?: string }) => void
  stopped: boolean
}

let listeners: Listener[]
let shown: boolean
let visibilityChanged: () => void
let grants: number

const source: LiveSignalSource = {
  subscribe(envKey, id, next, error) {
    const listener = { envKey, id, next, error, stopped: false }
    listeners.push(listener)
    return () => {
      listener.stopped = true
    }
  },
}

function hub() {
  const created = createLiveHub({
    source,
    now: () => Date.now(),
    visible: () => shown,
    watchVisibility: (changed) => {
      visibilityChanged = changed
      return () => {}
    },
  })
  created.setGrant(async (): Promise<LiveGrant> => {
    grants++
    return {
      envKey: 'development',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    }
  })
  return created
}

const active = (id: string) =>
  listeners.filter((listener) => listener.id === id && !listener.stopped)

/** Let the grant promise and the listener attach. */
const settle = () => vi.advanceTimersByTimeAsync(0)

/** Let the one catch-up refresh after the first snapshot run, then forget it. */
async function caughtUp(refresh: ReturnType<typeof vi.fn>) {
  await vi.advanceTimersByTimeAsync(2000)
  expect(refresh).toHaveBeenCalledTimes(1)
  refresh.mockClear()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-18T12:00:00.000Z'))
  listeners = []
  shown = true
  grants = 0
})

afterEach(() => {
  vi.useRealTimers()
})

test('refreshes once after the first snapshot, then on each newer revision', async () => {
  const refresh = vi.fn()
  const statuses: LiveStatus[] = []
  hub().subscribe({
    topics: ['pipeline'],
    refresh,
    onStatus: (status) => statuses.push(status),
  })
  await settle()
  const [listener] = active('topic:pipeline')
  expect(listener.envKey).toBe('development')

  listener.next(4)
  await settle()
  expect(statuses).toEqual(['connecting', 'live'])
  // The catch-up refresh waits out the throttle window that began at subscription.
  expect(refresh).not.toHaveBeenCalled()
  await caughtUp(refresh)

  await vi.advanceTimersByTimeAsync(5000)
  listener.next(4)
  await settle()
  expect(refresh).not.toHaveBeenCalled()

  listener.next(5)
  await settle()
  expect(refresh).toHaveBeenCalledTimes(1)
})

test('treats a missing signal document as revision zero', async () => {
  const refresh = vi.fn()
  hub().subscribe({ topics: ['research'], refresh })
  await settle()
  const [listener] = active('topic:research')
  listener.next(null)
  await caughtUp(refresh)
  await vi.advanceTimersByTimeAsync(5000)
  listener.next(1)
  await settle()
  expect(refresh).toHaveBeenCalledTimes(1)
})

test('refreshes each subscriber at most once per two seconds', async () => {
  const refresh = vi.fn()
  hub().subscribe({ topics: ['pipeline'], refresh })
  await settle()
  const [listener] = active('topic:pipeline')
  listener.next(1)
  await caughtUp(refresh)
  await vi.advanceTimersByTimeAsync(10_000)

  for (const revision of [2, 3, 4, 5]) listener.next(revision)
  await settle()
  expect(refresh).toHaveBeenCalledTimes(1)

  await vi.advanceTimersByTimeAsync(1999)
  expect(refresh).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(refresh).toHaveBeenCalledTimes(2)

  await vi.advanceTimersByTimeAsync(10_000)
  expect(refresh).toHaveBeenCalledTimes(2)
})

test('waits out the throttle window that starts at subscription', async () => {
  const refresh = vi.fn()
  hub().subscribe({ topics: ['pipeline'], refresh })
  await settle()
  const [listener] = active('topic:pipeline')
  listener.next(1)
  listener.next(2)
  await settle()
  expect(refresh).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2000)
  expect(refresh).toHaveBeenCalledTimes(1)
})

test('shares one listener and one grant between subscribers of a topic', async () => {
  const live = hub()
  const first = vi.fn()
  const second = vi.fn()
  const stopFirst = live.subscribe({ topics: ['pipeline'], refresh: first })
  live.subscribe({ topics: ['pipeline', 'publish'], refresh: second })
  await settle()
  expect(active('topic:pipeline')).toHaveLength(1)
  expect(active('topic:publish')).toHaveLength(1)
  expect(grants).toBe(1)

  const [pipeline] = active('topic:pipeline')
  pipeline.next(1)
  await vi.advanceTimersByTimeAsync(3000)
  pipeline.next(2)
  await vi.advanceTimersByTimeAsync(2000)
  // One catch-up refresh each after the first snapshot, then one for revision 2.
  expect(first).toHaveBeenCalledTimes(2)
  expect(second).toHaveBeenCalledTimes(2)

  stopFirst()
  expect(active('topic:pipeline')).toHaveLength(1)
})

test('stops listening in a background tab and catches up only if a change was missed', async () => {
  const refresh = vi.fn()
  hub().subscribe({ topics: ['pipeline'], refresh })
  await settle()
  active('topic:pipeline')[0].next(3)
  await caughtUp(refresh)

  shown = false
  visibilityChanged()
  expect(active('topic:pipeline')).toHaveLength(0)

  shown = true
  visibilityChanged()
  await settle()
  const [resumed] = active('topic:pipeline')
  resumed.next(3)
  await settle()
  expect(refresh).not.toHaveBeenCalled()

  shown = false
  visibilityChanged()
  shown = true
  visibilityChanged()
  await settle()
  active('topic:pipeline')[0].next(7)
  await vi.advanceTimersByTimeAsync(2000)
  expect(refresh).toHaveBeenCalledTimes(1)
})

test('pauses the safety refresh while hidden', async () => {
  const refresh = vi.fn()
  hub().subscribe({ topics: ['pipeline'], refresh, safetyMs: 60_000 })
  await settle()
  active('topic:pipeline')[0].next(1)
  await caughtUp(refresh)
  await vi.advanceTimersByTimeAsync(58_000)
  expect(refresh).toHaveBeenCalledTimes(1)

  shown = false
  visibilityChanged()
  await vi.advanceTimersByTimeAsync(180_000)
  expect(refresh).toHaveBeenCalledTimes(1)
})

test('falls back to one slow refresh loop when the listener fails', async () => {
  const refresh = vi.fn()
  const statuses: LiveStatus[] = []
  hub().subscribe({
    topics: ['pipeline'],
    refresh,
    onStatus: (status) => statuses.push(status),
  })
  await settle()
  active('topic:pipeline')[0].next(1)
  active('topic:pipeline')[0].error({ code: 'unavailable' })
  expect(statuses.at(-1)).toBe('unavailable')
  expect(active('topic:pipeline')).toHaveLength(0)

  await caughtUp(refresh)
  await vi.advanceTimersByTimeAsync(27_999)
  expect(refresh).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(refresh).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(refresh).toHaveBeenCalledTimes(2)
})

test('renews the grant once after a permission error before falling back', async () => {
  const refresh = vi.fn()
  const statuses: LiveStatus[] = []
  hub().subscribe({
    topics: ['publish'],
    refresh,
    onStatus: (status) => statuses.push(status),
  })
  await settle()
  active('topic:publish')[0].error({ code: 'permission-denied' })
  await settle()
  expect(grants).toBe(2)
  expect(active('topic:publish')).toHaveLength(1)
  expect(statuses.at(-1)).toBe('connecting')

  active('topic:publish')[0].error({ code: 'permission-denied' })
  await settle()
  expect(grants).toBe(2)
  expect(statuses.at(-1)).toBe('unavailable')
})

test('falls back when no live grant can be obtained', async () => {
  const live = createLiveHub({
    source,
    visible: () => true,
    watchVisibility: () => () => {},
  })
  live.setGrant(() => Promise.reject(new Error('offline')))
  const refresh = vi.fn()
  const statuses: LiveStatus[] = []
  live.subscribe({
    topics: ['pipeline'],
    refresh,
    onStatus: (status) => statuses.push(status),
  })
  await settle()
  expect(statuses.at(-1)).toBe('unavailable')
  await vi.advanceTimersByTimeAsync(30_000)
  expect(refresh).toHaveBeenCalledTimes(1)
})

test('stops the listener when the last subscriber leaves', async () => {
  const stop = hub().subscribe({ topics: ['pipeline'], refresh: vi.fn() })
  await settle()
  expect(active('topic:pipeline')).toHaveLength(1)
  stop()
  expect(active('topic:pipeline')).toHaveLength(0)
})

test('falls back when the listener cannot start', async () => {
  const live = createLiveHub({
    source: {
      subscribe() {
        throw new Error('Firebase is not configured')
      },
    },
    visible: () => true,
    watchVisibility: () => () => {},
  })
  live.setGrant(async () => ({
    envKey: 'development',
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  }))
  const statuses: LiveStatus[] = []
  live.subscribe({
    topics: ['pipeline'],
    refresh: vi.fn(),
    onStatus: (status) => statuses.push(status),
  })
  await settle()
  expect(statuses.at(-1)).toBe('unavailable')
})

test('falls back on a malformed grant without an unhandled rejection', async () => {
  const live = createLiveHub({
    source,
    visible: () => true,
    watchVisibility: () => () => {},
  })
  live.setGrant(async () => undefined as unknown as LiveGrant)
  const statuses: LiveStatus[] = []
  live.subscribe({
    topics: ['pipeline'],
    refresh: vi.fn(),
    onStatus: (status) => statuses.push(status),
  })
  await settle()
  expect(statuses.at(-1)).toBe('unavailable')
  expect(listeners).toHaveLength(0)
})
