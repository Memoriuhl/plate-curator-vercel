import type { ReviewBatch } from './types'

/** Route alias for the environment's shared working draft. */
export const SHARED_DRAFT_ALIAS = 'draft'

const draftPrefix = 'shared-draft-'

/** FNV-1a, enough to keep two environment names apart after they are made id-safe. */
function shortHash(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Name the shared draft document for one review environment. The `reviewBatches`
 * collection is shared by production, previews and development, so the environment is
 * part of the id. The id stays within the characters pipeline requests accept.
 */
export function sharedDraftId(env: string) {
  const safe = env.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)
  return `${draftPrefix}${safe === env ? safe : `${safe}-${shortHash(env)}`}`
}

/** Recognize the shared draft id, including the route alias. */
export function isSharedDraftId(id: string) {
  return id === SHARED_DRAFT_ALIAS || id.startsWith(draftPrefix)
}

/** Resolve the route alias to the environment's draft id; other ids pass through. */
export function resolveBatchId(id: string, env: string) {
  return id === SHARED_DRAFT_ALIAS ? sharedDraftId(env) : id
}

/** Whether a stored batch is the shared working draft. */
export function isSharedDraft(batch: Pick<ReviewBatch, 'kind'> | null) {
  return batch?.kind === 'shared-draft'
}

/** Whether a stored batch is a frozen copy of the draft made for one Publish. */
export function isRelease(batch: Pick<ReviewBatch, 'kind'> | null) {
  return batch?.kind === 'release'
}
