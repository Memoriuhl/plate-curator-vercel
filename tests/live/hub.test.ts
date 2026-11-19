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

/**
 * A poll owes a refresh from inside a timer, and the round it joins runs in the next
 * task, which timers clamp to one millisecond later.
 */
const pollTask = 1

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

test('refreshes the tab at most once per two seconds', async () => {
  const refresh = vi.fn()
  hub().subscribe({ topics: ['pipeline'], refresh })
  await settle()
  const [listener] = active('topic:pipeline')
  listener.next(1)
  await caughtUp(refresh)
  await vi.advanceTimersByTimeAsync(10_000)

  // A burst delivered together shares one refresh.
  for (const revision of [2, 3, 4, 5]) listener.next(revision)
  await settle()
  expect(refresh).toHaveBeenCalledTimes(1)

  // A later signal inside the window waits for its end.
  await vi.advanceTimersByTimeAsync(500)
  listener.next(6)
  await vi.advanceTimersByTimeAsync(1499)
  expect(refresh).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(refresh).toHaveBeenCalledTimes(2)

  await vi.advanceTimersByTimeAsync(10_000)
  expect(refresh).toHaveBeenCalledTimes(2)
})

test('one refresh round per two seconds across views and topics, and one request per key', async () => {
  const live = hub()
  const start = Date.now()
  const calls: { view: string; at: number }[] = []
  const view = (name: string) => () =>
    calls.push({ view: name, at: Date.now() - start })
  // The drawer summary and a run's result panel are mounted together, and two
  // components read the same summary.
  live.subscribe({
    topics: ['pipeline'],
    key: 'summary',
    refresh: view('summary'),
  })
  live.subscribe({
    topics: ['pipeline'],
    key: 'summary',
    refresh: view('summary copy'),
  })
  live.subscribe({
    topics: ['pipeline'],
    key: 'detail',
    refresh: view('detail'),
  })
  live.subscribe({
    topics: ['gateway'],
    key: 'gateway',
    refresh: view('gateway'),
  })
  await settle()
  const [pipeline] = active('topic:pipeline')
  const [gateway] = active('topic:gateway')
  pipeline.next(1)
  gateway.next(1)
  await vi.advanceTimersByTimeAsync(2000)
  expect(calls).toEqual([
    { view: 'summary', at: 2000 },
    { view: 'detail', at: 2000 },
    { view: 'gateway', at: 2000 },
  ])
  calls.length = 0
  await vi.advanceTimersByTimeAsync(8000)

  // A burst across topics: pipeline now, then Gateway and pipeline again half a second later.
  pipeline.next(2)
  await settle()
  await vi.advanceTimersByTimeAsync(500)
  gateway.next(2)
  pipeline.next(3)
  await vi.advanceTimersByTimeAsync(1499)
  expect(calls.map(({ at }) => at)).toEqual([10_000, 10_000])
  await vi.advanceTimersByTimeAsync(1)
  expect(calls).toEqual([
    { view: 'summary', at: 10_000 },
    { view: 'detail', at: 10_000 },
    { view: 'summary', at: 12_000 },
    { view: 'detail', at: 12_000 },
    { view: 'gateway', at: 12_000 },
  ])
})

test('a view that joins a topic already listening gets one catch-up read', async () => {
  const live = hub()
  const first = vi.fn()
  live.subscribe({ topics: ['pipeline'], key: 'queue', refresh: first })
  await settle()
  const [listener] = active('topic:pipeline')
  listener.next(1)
  await caughtUp(first)
  await vi.advanceTimersByTimeAsync(10_000)

  // A change lands after the preview fetched and before it subscribed; the shared
  // listener has already consumed it for the other view.
  listener.next(2)
  await settle()
  expect(first).toHaveBeenCalledTimes(1)
  first.mockClear()
  const late = vi.fn()
  live.subscribe({ topics: ['pipeline'], key: 'preview', refresh: late })
  await vi.advanceTimersByTimeAsync(1999)
  expect(late).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(late).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(late).toHaveBeenCalledTimes(1)
  expect(first).not.toHaveBeenCalled()
  expect(active('topic:pipeline')).toHaveLength(1)
})

test('changing the safety interval keeps the subscription and its listener', async () => {
  const refresh = vi.fn()
  const subscription = hub().subscribe({ topics: ['publish'], refresh })
  await settle()
  active('topic:publish')[0].next(1)
  await caughtUp(refresh)

  subscription.update({ safetyMs: 5000 })
  await vi.advanceTimersByTimeAsync(15_000 + pollTask)
  expect(refresh).toHaveBeenCalledTimes(3)
  subscription.update({})
  await vi.advanceTimersByTimeAsync(60_000)
  expect(refresh).toHaveBeenCalledTimes(3)
  expect(listeners).toHaveLength(1)
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

test('a refresh queued inside the throttle window waits while hidden and runs once on resume', async () => {
  const refresh = vi.fn()
  hub().subscribe({ topics: ['pipeline'], refresh })
  await settle()
  active('topic:pipeline')[0].next(1)
  await caughtUp(refresh)
  await vi.advanceTimersByTimeAsync(100)
  active('topic:pipeline')[0].next(2)
  await settle()
  expect(refresh).not.toHaveBeenCalled()

  shown = false
  visibilityChanged()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(refresh).not.toHaveBeenCalled()

  shown = true
  visibilityChanged()
  await settle()
  // The resumed listener reports the revision the tab already saw before hiding.
  active('topic:pipeline')[0].next(2)
  await settle()
  expect(refresh).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(refresh).toHaveBeenCalledTimes(1)
})

test('pauses grant renewal while hidden and renews on resume only when the grant is about to expire', async () => {
  hub().subscribe({ topics: ['pipeline'], refresh: vi.fn() })
  await settle()
  expect(grants).toBe(1)

  shown = false
  visibilityChanged()
  await vi.advanceTimersByTimeAsync(30 * 60_000)
  shown = true
  visibilityChanged()
  await settle()
  // Still valid for half an hour: no new grant.
  expect(grants).toBe(1)
  expect(active('topic:pipeline')).toHaveLength(1)

  shown = false
  visibilityChanged()
  await vi.advanceTimersByTimeAsync(3 * 60 * 60_000)
  expect(grants).toBe(1)
  shown = true
  visibilityChanged()
  await settle()
  expect(grants).toBe(2)
  expect(active('topic:pipeline')).toHaveLength(1)
})

test('pauses the safety refresh while hidden', async () => {
  const refresh = vi.fn()
  hub().subscribe({ topics: ['pipeline'], refresh, safetyMs: 60_000 })
  await settle()
  active('topic:pipeline')[0].next(1)
  await caughtUp(refresh)
  await vi.advanceTimersByTimeAsync(58_000 + pollTask)
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
  await vi.advanceTimersByTimeAsync(27_999 + pollTask)
  expect(refresh).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(refresh).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(refresh).toHaveBeenCalledTimes(2)
})

test('in fallback a view polls on one schedule and gets its safety interval back on recovery', async () => {
  const start = Date.now()
  const at: number[] = []
  const refresh = vi.fn(() => at.push(Date.now() - start))
  hub().subscribe({ topics: ['pipeline'], refresh, safetyMs: 60_000 })
  await settle()
  active('topic:pipeline')[0].next(1)
  active('topic:pipeline')[0].error({ code: 'unavailable' })
  await vi.advanceTimersByTimeAsync(125_000)
  expect(at).toEqual(
    [2000, 30_000, 60_000, 90_000, 120_000].map((ms, index) =>
      index ? ms + pollTask : ms
    )
  )

  // The listener recovers when the tab is shown again.
  at.length = 0
  shown = false
  visibilityChanged()
  shown = true
  visibilityChanged()
  await settle()
  active('topic:pipeline')[0].next(1)
  await settle()
  await vi.advanceTimersByTimeAsync(130_000)
  expect(at).toEqual([125_000, 185_000 + pollTask, 245_000 + pollTask])
})

test('in fallback a view with a shorter safety interval keeps only that schedule', async () => {
  const start = Date.now()
  const at: number[] = []
  hub().subscribe({
    topics: ['publish'],
    refresh: () => at.push(Date.now() - start),
    safetyMs: 5000,
  })
  await settle()
  active('topic:publish')[0].next(1)
  active('topic:publish')[0].error({ code: 'unavailable' })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(at).toEqual([
    2000,
    ...Array.from({ length: 11 }, (_, index) => (index + 1) * 5000 + pollTask),
  ])
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
  await vi.advanceTimersByTimeAsync(30_000 + pollTask)
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
