import { isRelease, isSharedDraft, isSharedDraftId } from './draft/draft-id'
import { reviewHref } from './href'
import type { ReviewBatch } from './types'

/**
 * Where a `?batch=` link opens now that curators share one draft:
 * - `draft`: the shared draft itself, opened as linked.
 * - `history`: a published Batch, a release, or a conflict Batch the migration left
 *   behind, opened read-only in Review.
 * - `moved`: an old Batch folded into the draft, one still open, or an id that no longer
 *   exists. The link opens the shared draft with a notice.
 */
export type BatchLink = 'draft' | 'history' | 'moved'

/** The query parameter that shows the notice after a `moved` redirect. */
export const OLD_BATCH_NOTICE = 'oldBatch'

/** Classify a linked Batch id, given the Batch it loaded (null when not found). */
export function batchLink(id: string, batch: ReviewBatch | null): BatchLink {
  if (isSharedDraftId(id) || isSharedDraft(batch)) return 'draft'
  if (!batch) return 'moved'
  return isRelease(batch) ||
    batch.state === 'published' ||
    batch.state === 'conflict'
    ? 'history'
    : 'moved'
}

/** Pages where `?batch=` selects what is shown: the Dashboard and Review. */
export function resolvesBatchLinks(pathname: string) {
  return /^\/(states|review)(\/|$)/.test(pathname)
}

/**
 * The URL a `?batch=` link on this page should become, or null to stay. A link that
 * stays on its page keeps its fragment (such as the Dashboard's `#families`); history
 * opens in Review, which has no such anchor.
 */
export function batchLinkRedirect(
  pathname: string,
  query: URLSearchParams,
  link: BatchLink,
  hash = ''
): string | null {
  const id = query.get('batch')
  if (!id || link === 'draft') return null
  if (link === 'history') {
    if (pathname.startsWith('/review')) return null
    const state = /^\/states\/([^/]+)/.exec(pathname)?.[1]
    return reviewHref(
      state && decodeURIComponent(state),
      query.get('plate') ?? undefined,
      id
    )
  }
  const next = new URLSearchParams(query)
  next.delete('batch')
  next.set(OLD_BATCH_NOTICE, '1')
  return `${pathname}?${next}${hash}`
}
