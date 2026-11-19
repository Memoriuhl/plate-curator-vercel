import { FieldValue, type Firestore } from '@google-cloud/firestore'
import { waitUntil } from '@vercel/functions'
import { liveEnvKey, signalPath } from '../review/signals/live-signal'
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

/** How long the platform keeps a function alive for one signal after its reply. */
export const signalDeadlineMs = 10_000

const pending = new Set<Promise<void>>()

/** Settle with `work`, or once `ms` pass, whichever is first. Never rejects. */
function atMost(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Tell listeners in the review environment that data under `topic` changed. Call it after
 * the change commits. It returns at once: the write runs in the background, so a slow or
 * failing topic never delays a worker reply, a workflow wake or a publish lease. A topic
 * has at most one write outstanding per instance, held until Firestore answers, so its
 * writes go out in order; later changes share one follow-up write. The platform keeps the
 * function alive for at most `signalDeadlineMs` per signal. A failed bump is logged, and
 * listeners keep a slow safety refresh for it.
 */
export function signalChange(
  db: Firestore,
  reviewEnv: string,
  topic: ChangeTopic
): void {
  const path = signalPath(liveEnvKey(reviewEnv), topicSignalId(topic))
  const dispatch = coalesce(path, async () => {
    // Even a database that throws before writing must not reach the caller.
    await db
      .doc(path)
      .set({ revision: FieldValue.increment(1) }, { merge: true })
  })
    .catch((error: unknown) => {
      console.warn(
        `[live] ${topic} change signal failed: ${error instanceof Error ? error.message : String(error)}`
      )
    })
    .finally(() => pending.delete(dispatch))
  pending.add(dispatch)
  waitUntil(atMost(dispatch, signalDeadlineMs))
}

/** Wait until every signal dispatched so far has settled. Used by tests and scripts. */
export async function settleSignals(): Promise<void> {
  while (pending.size) await Promise.all([...pending])
}
