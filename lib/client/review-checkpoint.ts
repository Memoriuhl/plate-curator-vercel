'use client'

import useSWR from 'swr'
import { useEffect } from 'react'
import { useSession } from './session'
import { isSharedDraftId } from '../review/draft/draft-id'

/**
 * Record the draft revision an owner has reviewed after the active view renders it. An
 * old Batch or a release is read-only history, so no checkpoint is sent for it.
 */
export function useReviewCheckpoint(
  batchId: string | null | undefined,
  revision: number | undefined,
  isOwner: boolean
) {
  const { api, user } = useSession()
  useEffect(() => {
    if (
      !user ||
      !isOwner ||
      !batchId ||
      !isSharedDraftId(batchId) ||
      revision === undefined
    )
      return
    void api
      .send(
        'POST',
        `/api/batches/${encodeURIComponent(batchId)}/review-checkpoint`,
        { revision }
      )
      .catch(() => undefined)
  }, [api, user, isOwner, batchId, revision])
}

/**
 * Cache changed plate IDs by batch and revisions so highlights follow the checkpoint.
 */
export function useRecentReviewPlates(
  batchId: string | null | undefined,
  since: number | undefined,
  revision?: number
) {
  const { api, user } = useSession()
  return useSWR<{ plateIds: string[] }>(
    user && batchId && since !== undefined
      ? `/api/batches/${encodeURIComponent(batchId)}/review-checkpoint?since=${since}${revision === undefined ? '' : `&revision=${revision}`}`
      : null,
    api.get
  )
}
