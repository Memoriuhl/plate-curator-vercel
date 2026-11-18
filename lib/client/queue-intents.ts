import type { EnqueueInput } from '../jobs/queue-types'
import { snapshotPipelineOptions } from '../jobs/pipeline-options'

type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type Intent = { fingerprint: string; requestId: string }
type Intents = { version: 1; intents: Intent[] }

/**
 * Canonicalize request data so equivalent object key orders reuse the same queue intent.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value
}

/**
 * Read the saved intent ledger and recover to an empty ledger if storage is unreadable.
 */
function read(storage: IntentStorage, key: string): Intents {
  try {
    const value = JSON.parse(storage.getItem(key) ?? 'null') as Intents | null
    if (value?.version === 1 && Array.isArray(value.intents)) return value
  } catch { return { version: 1, intents: [] } }
  return { version: 1, intents: [] }
}

/**
 * Reuse the request ID for an equivalent pending queue operation so a retry does not
 * enqueue it twice.
 */
export function queueRequestId(storage: IntentStorage, uid: string, operation: string, payload: unknown, id: () => string): string {
  const key = `local-pipeline-intent:${uid}:${operation}`
  const fingerprint = JSON.stringify(canonical(payload))
  const saved = read(storage, key)
  const previous = saved.intents.find(intent => intent.fingerprint === fingerprint)
  if (previous?.fingerprint === fingerprint && typeof previous.requestId === 'string') return previous.requestId
  if (saved.intents.length >= 20) throw Error('Too many unconfirmed queue requests; refresh saved runs first')
  const requestId = id()
  saved.intents.push({ fingerprint, requestId })
  storage.setItem(key, JSON.stringify(saved))
  return requestId
}

/**
 * Clear an acknowledged request from storage so a later deliberate action can get a new
 * ID.
 */
export function confirmQueueRequest(storage: IntentStorage, uid: string, operation: string, requestId: string) {
  const key = `local-pipeline-intent:${uid}:${operation}`
  const saved = read(storage, key)
  saved.intents = saved.intents.filter(intent => intent.requestId !== requestId)
  if (!saved.intents.length) storage.removeItem(key)
  else storage.setItem(key, JSON.stringify(saved))
}

/**
 * Normalize an enqueue selection and reserve its persistent request ID before sending
 * it.
 */
export function enqueueIntent(storage: IntentStorage, uid: string, input: Omit<EnqueueInput, 'requestId'>, id: () => string): EnqueueInput {
  const normalized = { ...input, options: snapshotPipelineOptions(input.stages, input.options ?? {}), previewOnly: input.previewOnly === true }
  return { ...normalized, requestId: queueRequestId(storage, uid, 'enqueue', normalized, id) }
}
