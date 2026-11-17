'use client'

import Link from 'next/link'
import { IoTimeOutline } from 'react-icons/io5'
import { useBatch, useBatches, useMe } from '@/lib/client/hooks'
import type { ReviewBatch } from '@/lib/review/types'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { cn } from '@/components/utils'
import { PublishButton } from './publish-button'

function ReviewChip({ batch, owner }: { batch: ReviewBatch; owner: boolean }) {
  const detail = useBatch(batch.id)
  const states = [
    ...new Set(detail.data?.plates.map((plate) => plate.baseline.state) ?? []),
  ].join(', ')
  return (
    <div className="review-chip">
      <Avatar size="sm" player="friend">
        <AvatarFallback>
          {batch.createdBy.slice(0, 1).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <strong className="review-states" title={states || undefined}>
        {states || (detail.error ? 'Unavailable' : '…')}
      </strong>
      <span className="review-plate-count">
        {batch.plateIds.length} {batch.plateIds.length === 1 ? 'plate' : 'plates'}
      </span>
      <span
        className={cn(
          'review-status',
          batch.state === 'approved' ? 'review-approved' : 'review-submitted',
        )}
      >
        {batch.state === 'approved' ? 'Approved' : 'Submitted'}
      </span>
      <span className="review-revision">Rev {batch.revision}</span>
      <div className="review-actions">
        <Button asChild size="sm">
          <Link href={`/review?batch=${encodeURIComponent(batch.id)}`}>
            Review
          </Link>
        </Button>
        <PublishButton owner={owner} approved={batch.state === 'approved'} size="sm" />
      </div>
    </div>
  )
}

export function ReviewStrip() {
  const { data, error, isLoading } = useBatches(['submitted', 'approved'])
  const me = useMe()
  if (error)
    return <p role="alert">Could not load batches waiting for review.</p>
  if (isLoading)
    return (
      <div className="review-loading flex h-11 items-center" role="status">
        Loading review batches…
      </div>
    )
  if (!data?.length) return null
  return (
    <section className="review-strip" aria-label="Waiting for review">
      <strong className="review-label">
        <IoTimeOutline aria-hidden="true" />
        Waiting for review
      </strong>
      {data.map((batch) => (
        <ReviewChip
          key={batch.id}
          batch={batch}
          owner={me.data?.role === 'owner'}
        />
      ))}
    </section>
  )
}
