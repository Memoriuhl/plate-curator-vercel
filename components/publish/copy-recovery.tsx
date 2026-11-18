'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ApiError } from '@/lib/client/api'
import { useReviewActions } from '@/lib/client/hooks'
import type { ReviewBatch } from '@/lib/review/types'
import { Button } from '@/components/ui/button'

/**
 * Offer a fresh-baseline copy when a batch cannot continue publishing from its original
 * snapshot.
 */
export function CopyRecovery({ batch, liveVersion, receiptConflict }: { batch: ReviewBatch; liveVersion: number; receiptConflict: boolean }) {
  const router = useRouter()
  const actions = useReviewActions()
  const [targetVersion, setTargetVersion] = useState(liveVersion)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [reasons, setReasons] = useState<string[]>([])
  const [copiedId, setCopiedId] = useState<string | null>(null)

  /**
   * Copy the batch and expose the new draft link or the validation reasons preventing
   * it.
   */
  async function copy() {
    setBusy(true)
    setMessage('')
    setReasons([])
    try {
      const copied = await actions.copy(batch.id, batch.revision, targetVersion)
      if (copied.warnings?.length) {
        setCopiedId(copied.id)
        setReasons(copied.warnings)
        setMessage('Copied to a new Batch. Repair these Standard issues there before submitting.')
      } else router.push(`/review?batch=${encodeURIComponent(copied.id)}`)
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
    <div role="alert" className="grid gap-[var(--stack-gap)] rounded-2xl border border-border p-4">
      <p>Reviewed Catalog v{batch.baselineVersion}; current Catalog v{targetVersion}. {receiptConflict ? 'The interrupted Publish used an unreviewed baseline; its receipt needs triage.' : 'Publish stopped because the baseline changed.'}</p>
      <p>Copy the proposals into a new Batch based on the current Catalog, then review the changes before publishing.</p>
      {copiedId ? <Button asChild><Link href={`/review?batch=${encodeURIComponent(copiedId)}`}>Open copied Batch</Link></Button> : <Button disabled={busy} onClick={copy}>{busy ? 'Copying…' : 'Copy to new Batch'}</Button>}
      {message && <p role="status">{message}</p>}
      {reasons.length > 0 && <ul>{reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
    </div>
  )
}
