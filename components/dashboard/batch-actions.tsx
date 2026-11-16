'use client'

import { useState } from 'react'
import {
  IoChevronDown,
  IoPlay,
  IoArrowUpOutline,
  IoPaperPlaneOutline,
} from 'react-icons/io5'
import {
  useBatch,
  useBatches,
  useMe,
  useReviewActions,
} from '@/lib/client/hooks'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { ComingSoon } from './coming-soon'

export function BatchActions() {
  const batches = useBatches(['open'], { mine: true })
  const batch = batches.data?.[0]
  const detail = useBatch(batch?.id ?? null)
  const me = useMe()
  const actions = useReviewActions()
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const edits =
    detail.data?.plates.filter((plate) => plate.edit !== null).length ?? 0
  return (
    <div className="batch-actions">
      {batch ? (
        <span className="batch-summary">
          <Avatar size="sm">
            <AvatarFallback>
              {(me.data?.uid ?? batch.createdBy).slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span>
            Your batch:{' '}
            {detail.isLoading ? 'Loading…' : `${edits} changes, saved`}
          </span>
        </span>
      ) : null}
      <Button
        variant="outline"
        disabled={!batch || !detail.data || !!detail.error || !edits || pending}
        onClick={async () => {
          if (!detail.data) return
          setPending(true)
          setMessage('')
          try {
            await actions.submit(
              detail.data.batch.id,
              detail.data.batch.revision,
            )
            setMessage('Submitted for review.')
          } catch {
            setMessage('Could not submit your batch. Please try again.')
          } finally {
            setPending(false)
          }
        }}
      >
        <IoPaperPlaneOutline aria-hidden="true" />
        {pending ? 'Submitting…' : 'Submit for review'}
      </Button>
      <ComingSoon label="Run pipeline">
        <IoPlay aria-hidden="true" />
        Run pipeline
        <IoChevronDown aria-hidden="true" />
      </ComingSoon>
      {me.data?.role === 'owner' ? (
        <ComingSoon label="Publish" variant="publish">
          <IoArrowUpOutline aria-hidden="true" />
          Publish
        </ComingSoon>
      ) : null}
      {batches.error || detail.error ? (
        <span role="alert">Could not load your batch.</span>
      ) : null}
      {message ? <span role="status">{message}</span> : null}
    </div>
  )
}
