import { FieldValue, type Firestore } from '@google-cloud/firestore'
import { waitUntil } from '@vercel/functions'
import { liveEnvKey, signalPath } from '../review/live-signal'
import { topicSignalId, type ChangeTopic } from './topics'

type Slot = { running: Promise<void> | null; queued: Promise<void> | null }

const slots = new Map<string, Slot>()

/**
 * Run `write` now, or once more after the write in flight for the same key. Callers that
 * arrive while a follow-up is already queued share it, because it starts after their own
 * change committed. A burst of changes therefore costs at most two writes per round trip.
 */
export function coalesce(
  key: string,
  write: () => Promise<unknown>
): Promise<void> {
  let slot = slots.get(key)
  if (!slot) {
    slot = { running: null, queued: null }
    slots.set(key, slot)
  }
  const current = slot
  const start = () => {
    const running: Promise<void> = write()
      .then(() => undefined)
      .finally(() => {
        if (current.running === running) current.running = null
        if (!current.running && !current.queued) slots.delete(key)
      })
    current.running = running
    return running
  }
  if (current.queued) return current.queued
  if (current.running) {
    const queued = current.running
      .catch(() => undefined)
      .then(() => {
        current.queued = null
        return start()
      })
    current.queued = queued
    return queued
  }
  return start()
}

/** How long one topic write may hold its topic before later changes go out without it. */
export const signalDeadlineMs = 10_000

const pending = new Set<Promise<void>>()

/** Resolve after `write`, or reject once `ms` pass without it settling. */
function withDeadline(write: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)
  })
  return Promise.race([write.then(() => undefined), late]).finally(() =>
    clearTimeout(timer)
  )
}

/**
 * Tell listeners in the review environment that data under `topic` changed. Call it after
 * the change commits. It returns at once: the write runs in the background, so a slow or
 * failing topic never delays a worker reply, a workflow wake or a publish lease. On
 * Vercel the function stays alive until the write settles, at most `signalDeadlineMs`
 * per write. A failed bump is logged, and listeners keep a slow safety refresh for it.
 */
export function signalChange(
  db: Firestore,
  reviewEnv: string,
  topic: ChangeTopic
): void {
  const path = signalPath(liveEnvKey(reviewEnv), topicSignalId(topic))
  const dispatch = coalesce(path, () => {
    // Even a database that throws before writing must not reach the caller.
    try {
      return withDeadline(
        db
          .doc(path)
          .set({ revision: FieldValue.increment(1) }, { merge: true }),
        signalDeadlineMs
      )
    } catch (error) {
      return Promise.reject(error)
    }
  })
    .catch((error: unknown) => {
      console.warn(
        `[live] ${topic} change signal failed: ${error instanceof Error ? error.message : String(error)}`
      )
    })
    .finally(() => pending.delete(dispatch))
  pending.add(dispatch)
  waitUntil(dispatch)
}

/** Wait until every signal dispatched so far has settled. Used by tests and scripts. */
export async function settleSignals(): Promise<void> {
  while (pending.size) await Promise.all([...pending])
}
