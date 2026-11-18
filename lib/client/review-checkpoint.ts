'use client'

import useSWR from 'swr'
import { useEffect } from 'react'
import { useSession } from './session'

export function useReviewCheckpoint(batchId: string | null | undefined, revision: number | undefined, isOwner: boolean) {
  const { api, user } = useSession()
  useEffect(() => {
    if (!user || !isOwner || !batchId || revision === undefined) return
    void api.send('POST', `/api/batches/${encodeURIComponent(batchId)}/review-checkpoint`, { revision }).catch(() => undefined)
  }, [api, user, isOwner, batchId, revision])
}

export function useRecentReviewPlates(batchId: string | null | undefined, since: number | undefined, revision?: number) {
  const { api, user } = useSession()
  return useSWR<{ plateIds: string[] }>(user && batchId && since !== undefined
    ? `/api/batches/${encodeURIComponent(batchId)}/review-checkpoint?since=${since}${revision === undefined ? '' : `&revision=${revision}`}`
    : null, api.get)
}
