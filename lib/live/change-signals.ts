import { FieldValue, type Firestore } from '@google-cloud/firestore'
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

/**
 * Tell listeners in the review environment that data under `topic` changed. Call it after
 * the change commits. The signal is best effort: a failed bump is logged and never fails
 * the caller's operation, and listeners keep a slow safety refresh for that case.
 */
export async function signalChange(
  db: Firestore,
  reviewEnv: string,
  topic: ChangeTopic
): Promise<void> {
  const path = signalPath(liveEnvKey(reviewEnv), topicSignalId(topic))
  try {
    await coalesce(path, () =>
      db.doc(path).set({ revision: FieldValue.increment(1) }, { merge: true })
    )
  } catch (error) {
    console.warn(
      `[live] ${topic} change signal failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
