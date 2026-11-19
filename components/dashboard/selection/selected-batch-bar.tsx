'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { batchApiPath, isDashboardDraftKey } from '@/lib/client/api'
import { useDraftOverview, useMe, useWorkspaceBatch } from '@/lib/client/hooks'
import {
  useBatchRevisionSignal,
  useDashboardDraftSignal,
} from '@/lib/client/live-signal'
import { useSWRConfig } from 'swr'
import { Button } from '@/components/ui/button'
import { isSharedDraft, SHARED_DRAFT_ALIAS } from '@/lib/review/draft/draft-id'
import { batchHref } from '@/lib/review/href'

/**
 * Keep the selected batch connected to live revisions and provide a return link to its
 * review.
 */
export function SelectedBatchBar({
  stateScope = false,
}: {
  stateScope?: boolean
}) {
  const workspace = useWorkspaceBatch()
  const pathname = usePathname()
  const params = useSearchParams()
  const { mutate } = useSWRConfig()
  const selected = workspace.mode === 'selected'
  const batch = selected ? workspace.detail?.batch : undefined
  const draftId = useMe(stateScope && selected).data?.draftId ?? null
  const code = stateScope
    ? /^\/states\/([A-Z]{2})$/i.exec(pathname)?.[1].toUpperCase()
    : undefined
  const scoped =
    !!code &&
    !!draftId &&
    selected &&
    (workspace.id === draftId || workspace.id === SHARED_DRAFT_ALIAS)
  const overview = useDraftOverview(scoped ? draftId : null)
  const refreshState = () => mutate((key) => isDashboardDraftKey(key, code))
  const stateLive = useDashboardDraftSignal(scoped ? code : null, refreshState)
  const batchLive = useBatchRevisionSignal(
    selected && !scoped && (!code || (batch && !isSharedDraft(batch)))
      ? workspace.id
      : null,
    batch?.revision ?? -1
  )
  const live = scoped
    ? {
        live: 'Live',
        connecting: 'Updating',
        unavailable: 'Live updates unavailable',
      }[stateLive]
    : batchLive
  const revision = Math.max(
    batch?.revision ?? -1,
    overview?.batch.revision ?? -1
  )
  if (!selected) return null
  const back = new URLSearchParams(params.toString())
  back.delete('batch')
  return (
    <div
      className="batch-actions"
      aria-label="Selected Batch"
      data-batch-id={workspace.id}
      data-batch-revision={revision < 0 ? undefined : revision}
    >
      {!batch ? (
        <strong>
          {workspace.status === 'unavailable'
            ? "This Batch isn't available"
            : 'Loading Batch...'}
        </strong>
      ) : null}
      {workspace.status === 'unavailable' && batch ? (
        <span>{"This Batch isn't available"}</span>
      ) : null}
      {workspace.status === 'read-only' ? <span>Read-only</span> : null}
      <span role="status">{live}</span>
      {live === 'Live updates unavailable' ? (
        <Button
          variant="outline"
          onClick={() =>
            void (scoped ? refreshState() : mutate(batchApiPath(workspace.id)))
          }
        >
          Refresh
        </Button>
      ) : null}
      <Button
        variant="outline"
        onClick={() =>
          void navigator.clipboard.writeText(
            location.origin + batchHref(pathname, workspace.id)
          )
        }
      >
        Copy link
      </Button>
      <Link href={pathname + (back.size ? '?' + back.toString() : '')}>
        Back to the shared draft
      </Link>
    </div>
  )
}
