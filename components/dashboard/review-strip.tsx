'use client'

import Link from 'next/link'
import { IoTimeOutline } from 'react-icons/io5'
import { useBatch, useMe, useSharedDraftId } from '@/lib/client/hooks'
import { Button } from '@/components/ui/button'
import { PublishButton } from './publish-button'
import { BatchLastChanged } from '@/components/review/batch-last-changed'

/**
 * Summarize the shared draft's unpublished changes on the Dashboard. There is no Submit
 * or Approve step: every curator's changes wait here until the Owner publishes them.
 */
export function ReviewStrip() {
  const draftId = useSharedDraftId()
  const detail = useBatch(draftId, { reuse: true })
  const me = useMe()
  if (detail.error)
    return <p role="alert">Could not load the shared draft.</p>
  const batch = detail.data?.batch
  if (!batch || !draftId) return null
  const states = [
    ...new Set([
      ...batch.plateIds.map((id) => id.split('.')[0]),
      ...Object.keys(batch.stateOrders),
    ]),
  ].sort()
  if (!batch.plateIds.length && !states.length) return null
  return (
    <section className="review-strip" aria-label="Unpublished changes">
      <strong className="review-label">
        <IoTimeOutline aria-hidden="true" />
        Unpublished changes
      </strong>
      <div className="review-chip">
        <strong className="review-states" title={states.join(', ')}>
          {states.join(', ') || '…'}
        </strong>
        <span className="review-plate-count">
          {batch.plateIds.length}{' '}
          {batch.plateIds.length === 1 ? 'plate' : 'plates'}
        </span>
        <span className="review-status review-submitted">
          Shared draft · rev {batch.revision}
        </span>
        <span className="review-last-changed">
          <BatchLastChanged batch={batch} />
        </span>
        <div className="review-actions">
          <Button asChild size="sm">
            <Link href="/review">Review</Link>
          </Button>
          <PublishButton
            batchId={draftId}
            owner={me.data?.role === 'owner'}
            size="sm"
          />
        </div>
      </div>
    </section>
  )
}
