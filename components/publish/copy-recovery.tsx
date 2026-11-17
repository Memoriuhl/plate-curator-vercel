'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ApiError } from '@/lib/client/api'
import { useReviewActions } from '@/lib/client/hooks'
import type { ReviewBatch } from '@/lib/review/types'
import { Button } from '@/components/ui/button'

export function CopyRecovery({ batch, liveVersion, receiptConflict }: { batch: ReviewBatch; liveVersion: number; receiptConflict: boolean }) {
  const router = useRouter()
  const actions = useReviewActions()
  const [targetVersion, setTargetVersion] = useState(liveVersion)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [reasons, setReasons] = useState<string[]>([])

  async function copy() {
    setBusy(true)
    setMessage('')
    setReasons([])
    try {
      const copied = await actions.copy(batch.id, batch.revision, targetVersion)
      router.push(`/review?batch=${encodeURIComponent(copied.id)}`)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'head_moved' && typeof error.body.liveVersion === 'number') {
        setTargetVersion(error.body.liveVersion)
        setMessage(`The Catalog moved to v${error.body.liveVersion}. Choose Copy to new Batch again to review that version.`)
      } else {
        const messages: Record<string, string> = {
          incompatible: 'These proposals need manual recovery. The original Batch is preserved.',
          unavailable: 'The current Catalog is temporarily unavailable. Try Copy to new Batch again.',
        }
        setMessage(error instanceof ApiError ? messages[error.code] ?? 'Could not copy this Batch. Refresh and try again.' : 'Could not copy this Batch. Refresh and try again.')
        if (error instanceof ApiError && Array.isArray(error.body.reasons)) setReasons(error.body.reasons.filter((reason): reason is string => typeof reason === 'string'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="alert" className="space-y-3 rounded-2xl border border-border p-4">
      <p>Reviewed Catalog v{batch.baselineVersion}; current Catalog v{targetVersion}. {receiptConflict ? 'The interrupted Publish used an unreviewed baseline; its receipt needs triage.' : 'Publish stopped because the baseline changed.'}</p>
      <p>Copy the proposals for a fresh review. The new Batch requires Submit, Approve, and Publish.</p>
      <Button disabled={busy} onClick={copy}>{busy ? 'Copying…' : 'Copy to new Batch'}</Button>
      {message && <p role="status">{message}</p>}
      {reasons.length > 0 && <ul>{reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
    </div>
  )
}
