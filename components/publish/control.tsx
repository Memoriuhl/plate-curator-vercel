'use client'

import { publishControlStop } from '@/lib/publish/control'
import { PUBLISH_STOP_MESSAGES } from '@/lib/publish/stop'
import { useState } from 'react'
import type { PublishControlState } from '@/lib/publish/types'
import { Button } from '@/components/ui/button'

/** Show current release controls and offer the available pause or resume action. */
export function PublishControlView({
  control,
  enabledHere,
  loading,
  error,
  change,
  inset = false,
}: {
  control: PublishControlState | null
  enabledHere?: boolean
  loading?: boolean
  error?: boolean
  change: (paused: boolean) => Promise<void>
  /** Drop the card surface when the control sits inside another card. */
  inset?: boolean
}) {
  const stop = publishControlStop(control)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  return (
    <section
      aria-label="Catalog publishing control"
      className={
        inset ? 'space-y-3 text-sm' : 'space-y-3 rounded-2xl bg-card p-4'
      }
    >
      <p className="font-bold">
        {error
          ? 'Catalog publishing'
          : loading
            ? 'Checking catalog publishing…'
            : stop
              ? PUBLISH_STOP_MESSAGES[stop]
              : 'Catalog publishing is enabled.'}
      </p>
      {control && (
        <p className="text-xs text-muted-foreground">
          Changed by {control.changedBy.email} at{' '}
          <time dateTime={control.changedAt}>
            {new Date(control.changedAt).toLocaleString()}
          </time>
          .
        </p>
      )}
      {enabledHere === false ? (
        <p className="text-sm">
          Use a publishing-enabled deployment to change this switch.
        </p>
      ) : (
        stop &&
        !loading &&
        !error && <p className="text-sm">Resume allows new Publish requests.</p>
      )}
      {error && (
        <p role="alert">
          Publishing controls are unavailable. Publishing is blocked.
        </p>
      )}
      {message && <p role="alert">{message}</p>}
      {enabledHere !== false && !loading && (
        <Button
          variant="outline"
          disabled={busy || error}
          onClick={async () => {
            setBusy(true)
            setMessage('')
            try {
              await change(control ? !control.paused : false)
            } catch {
              setMessage('Could not change publishing. Refresh and try again.')
            } finally {
              setBusy(false)
            }
          }}
        >
          {control && !control.paused
            ? 'Pause publishing'
            : 'Resume publishing'}
        </Button>
      )}
    </section>
  )
}
