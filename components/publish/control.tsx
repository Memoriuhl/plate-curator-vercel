'use client'

import { useState } from 'react'
import type { PublishControlState } from '@/lib/publish/types'
import { Button } from '@/components/ui/button'

export function PublishControlView({ control, error, change }: {
  control: PublishControlState | null
  error?: boolean
  change: (paused: boolean) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  return <section aria-label="Catalog publishing control" className="space-y-3 rounded-2xl border border-border p-4">
    <p className="font-bold">{!control ? 'Catalog publishing is not enabled yet.' : control.paused ? 'Catalog publishing is paused.' : 'Catalog publishing is enabled.'}</p>
    {control && <p className="text-sm text-muted-foreground">Changed by {control.changedBy.email} at <time dateTime={control.changedAt}>{new Date(control.changedAt).toLocaleString()}</time>.</p>}
    <p className="text-sm">Draft work and approval can continue. Resume permits new Publish requests; stopped commands stay stopped.</p>
    {error && <p role="alert">Publishing controls are unavailable. Publishing is blocked.</p>}
    {message && <p role="alert">{message}</p>}
    <Button variant="outline" disabled={busy || error} onClick={async () => {
      setBusy(true)
      setMessage('')
      try { await change(control ? !control.paused : false) }
      catch { setMessage('Could not change publishing. Refresh and try again.') }
      finally { setBusy(false) }
    }}>{control && !control.paused ? 'Pause publishing' : 'Resume publishing'}</Button>
  </section>
}
