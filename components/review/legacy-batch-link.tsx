'use client'

import { useEffect } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ApiError } from '../../lib/client/api'
import { useBatch } from '../../lib/client/hooks'
import { isSharedDraftId } from '../../lib/review/draft-id'
import {
  batchLink,
  batchLinkRedirect,
  OLD_BATCH_NOTICE,
  resolvesBatchLinks,
} from '../../lib/review/legacy-link'

/**
 * Send old `?batch=` links on the Dashboard and Review to what they mean now: the shared
 * draft (with a notice) for Batches folded into it, still open or gone, and read-only
 * Review for published history. Shows the notice after such a redirect.
 */
export function LegacyBatchLink() {
  const query = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const id = query.get('batch')
  const watched = !!id && !isSharedDraftId(id) && resolvesBatchLinks(pathname)
  const detail = useBatch(watched ? id : null, { reuse: true })
  const missing =
    detail.error instanceof ApiError && detail.error.status === 404
  const target =
    watched && (detail.data || missing)
      ? batchLinkRedirect(
          pathname,
          query,
          batchLink(id, detail.data?.batch ?? null)
        )
      : null
  useEffect(() => {
    if (target) router.replace(target)
  }, [router, target])

  if (query.get(OLD_BATCH_NOTICE) !== '1') return null
  const dismiss = () => {
    const next = new URLSearchParams(query)
    next.delete(OLD_BATCH_NOTICE)
    router.replace(next.size ? `${pathname}?${next}` : pathname)
  }
  return (
    <div
      role="status"
      className="mx-6 mt-4 flex flex-wrap items-center gap-3 rounded-md border bg-muted px-3 py-2 text-sm"
    >
      <p>
        This link pointed to an old Batch. Its changes are now in the shared
        draft, which every curator edits together.
      </p>
      <button type="button" className="underline" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  )
}
