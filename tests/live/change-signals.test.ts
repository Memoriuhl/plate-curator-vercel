import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Firestore } from '@google-cloud/firestore'

const platform = vi.hoisted(() => ({ waitUntil: vi.fn() }))
vi.mock('@vercel/functions', () => platform)

import {
  coalesce,
  settleSignals,
  signalChange,
  signalDeadlineMs,
} from '../../lib/live/change-signals'

type Gate = { promise: Promise<void>; open: () => void; fail: () => void }

function gate(): Gate {
  let open!: () => void
  let fail!: () => void
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve
    fail = () => reject(new Error('topic write refused'))
  })
  return { promise, open, fail }
}

/** A Firestore stand-in whose topic writes follow the given script. */
function store(write: () => Promise<unknown>) {
  const set = vi.fn(write)
  const db = { doc: vi.fn(() => ({ set })) } as unknown as Firestore
  return { db, set }
}

/** Let promise callbacks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  platform.waitUntil.mockReset()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('a held topic write hands control straight back and keeps the function alive for it', async () => {
  const held = gate()
  const { db, set } = store(() => held.promise)

  expect(signalChange(db, 'preview:x', 'pipeline')).toBeUndefined()
  expect(set).toHaveBeenCalledTimes(1)
  // The platform keeps the function running until the dispatch settles.
  expect(platform.waitUntil).toHaveBeenCalledTimes(1)

  let settled = false
  void settleSignals().then(() => (settled = true))
  await flush()
  expect(settled).toBe(false)

  held.open()
  await settleSignals()
  expect(settled).toBe(true)
})

test('a rejected topic write is logged and never reaches the caller', async () => {
  const refused = gate()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const { db } = store(() => refused.promise)

  expect(() => signalChange(db, 'preview:x', 'publish')).not.toThrow()
  refused.fail()
  await settleSignals()
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('publish change signal failed')
  )
})

test('a database that throws at once is logged like any other failed write', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const db = {
    doc: () => {
      throw new Error('no database')
    },
  } as unknown as Firestore

  expect(() => signalChange(db, 'preview:x', 'research')).not.toThrow()
  await settleSignals()
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('research change signal failed')
  )
})

test('a slow write keeps later bumps queued behind it, so one write per topic is outstanding and they stay in order', async () => {
  vi.useFakeTimers()
  const writes: Gate[] = []
  const { db, set } = store(() => {
    const next = gate()
    writes.push(next)
    return next.promise
  })

  signalChange(db, 'preview:x', 'gateway')
  signalChange(db, 'preview:x', 'gateway')
  signalChange(db, 'preview:x', 'gateway')
  expect(set).toHaveBeenCalledTimes(1)

  // Past the deadline the function is no longer kept alive for the write...
  const kept = platform.waitUntil.mock.calls.map(([work]) => work)
  let released = 0
  for (const work of kept) void work.then(() => released++)
  await vi.advanceTimersByTimeAsync(signalDeadlineMs)
  expect(released).toBe(kept.length)
  // ...but the topic stays held: no second write starts while the first is open.
  await vi.advanceTimersByTimeAsync(10 * signalDeadlineMs)
  expect(set).toHaveBeenCalledTimes(1)

  writes[0].open()
  await vi.advanceTimersByTimeAsync(0)
  // The bumps that arrived meanwhile share one follow-up write.
  expect(set).toHaveBeenCalledTimes(2)
  writes[1].open()
  await settleSignals()
  expect(set).toHaveBeenCalledTimes(2)
})

test('coalesces signal writes to one in flight and one queued', async () => {
  const resolvers: (() => void)[] = []
  const write = vi.fn(
    () => new Promise<void>((resolve) => resolvers.push(resolve))
  )
  const first = coalesce('signal', write)
  const second = coalesce('signal', write)
  const third = coalesce('signal', write)
  expect(second).toBe(third)
  expect(write).toHaveBeenCalledTimes(1)
  resolvers[0]()
  await first
  await flush()
  expect(write).toHaveBeenCalledTimes(2)
  resolvers[1]()
  await Promise.all([second, third])
  expect(write).toHaveBeenCalledTimes(2)

  await coalesce('signal', async () => {})
  expect(write).toHaveBeenCalledTimes(2)
})
