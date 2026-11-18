'use client'

import { ApiError } from '@/lib/client/api'
import { isPublishStop, PIPELINE_BUSY, PIPELINE_BUSY_MESSAGE, PUBLISH_STOPS, PUBLISH_STOP_MESSAGES } from '@/lib/publish/stop'
import { draftCanBeConfirmed } from '@/lib/publish/command'
import type { ReviewChanges } from '@/lib/review/checkpoint'
import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { BASELINE_ERRORS, isBaselineError } from '@/lib/publish/baseline'
import { PublishControlView } from './control'
import { CopyRecovery } from './copy-recovery'
import {
  useBatch,
  useBatches,
  useBatchRun,
  useMe,
  usePublishBaseline,
  usePublishControl,
  useReviewActions,
} from '@/lib/client/hooks'
import type { ReviewBatch } from '@/lib/review/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/components/utils'
import { groupChanges } from '@/components/review/diff'
import { BatchChanges } from './batch-changes'
import { RunStatus } from '@/components/review/run-status'

function BatchItem({
  batch,
  selected,
  onSelect,
}: {
  batch: ReviewBatch
  selected: boolean
  onSelect: () => void
}) {
  const run = useBatchRun(batch.state === 'published' ? batch.id : null)
  const version = run.data?.outcome?.version
  const publishedAt = batch.state === 'published' ? run.data?.updatedAt : null
  const date = publishedAt ?? batch.approval?.at ?? batch.createdAt
  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full rounded-2xl border p-4 text-left',
        selected ? 'border-primary bg-muted' : 'border-transparent bg-card',
      )}
    >
      {batch.state === 'published' ? (version == null ? <strong className="mb-2 block">Published</strong> : <span className="mb-2 block text-4xl font-extrabold tracking-tight">v{version}</span>) : <span className="mb-2 inline-block rounded-full bg-[var(--warning-tint)] text-[var(--warning-ink)] px-2 py-1 text-xs font-semibold">{batch.state === 'approved' ? 'Approved · waiting' : 'Draft'}</span>}
      <strong className="block">{batch.name}</strong>
      <span className="block text-sm text-muted-foreground">
        {batch.createdByName || 'Curator'} · revision{' '}
        {batch.approval?.revision ?? batch.revision}
      </span>
      <time dateTime={date} className="mt-2 block text-xs text-muted-foreground">
        {publishedAt ? 'Published' : batch.approval?.at ? 'Approved' : 'Created'} {new Date(date).toLocaleString()}
      </time>
    </button>
  )
}

function BatchSelection({
  id,
  onPublish,
}: {
  id: string
  onPublish: () => void
}) {
  const detail = useBatch(id)
  const run = useBatchRun(id)
  const baseline = usePublishBaseline(id)
  const actions = useReviewActions()
  const dialog = useRef<HTMLDialogElement>(null)
  const [abandonReason, setAbandonReason] = useState('')
  const [abandonMessage, setAbandonMessage] = useState('')
  const [openedConfirmation, setConfirmation] = useState<ReviewChanges | null>(null)
  const [confirmationMessage, setConfirmationMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [requestedFrom, setRequestedFrom] = useState<string | null | undefined>(undefined)
  const [rejectedLiveVersion, setRejectedLiveVersion] = useState<number | null>(null)
  const groups = useMemo(() => groupChanges(detail.data?.plates ?? []), [detail.data])
  if (detail.error) return <p role="alert">Could not load this Batch.</p>
  if (!detail.data) return <p role="status">Loading Batch…</p>
  const { batch, plates } = detail.data
  const nextConfirmation = baseline.data?.confirmation
  const confirmation = openedConfirmation && nextConfirmation?.revision === batch.revision && nextConfirmation.revision > openedConfirmation.revision
    ? nextConfirmation
    : openedConfirmation
  const revisionChanged = !!confirmation && confirmation.revision !== openedConfirmation?.revision
  const counts = Object.entries(groups)
    .filter(([, entries]) => entries.length > 0)
    .map(([name, entries]) => `${entries.length} ${name.toLowerCase()}`)
    .join(', ')
  const revision = batch.approval?.revision ?? (draftCanBeConfirmed(batch) ? batch.revision : undefined)
  const canConfirmDraft = baseline.data?.canConfirmDraft === true
  const pipelineBusy = baseline.data?.pipelineBusy === true
  const failed = run.data?.outcome
  const stopped = isPublishStop(failed?.error) || !!baseline.data?.stopped
  const canRetry = baseline.data?.canRetry === true
  const requested = requestedFrom !== undefined && requestedFrom === (run.data?.runId ?? null)
  const receiptConflict = baseline.data?.error === BASELINE_ERRORS.receiptConflict || failed?.error === BASELINE_ERRORS.receiptConflict
  const blocked = baseline.data?.error || rejectedLiveVersion !== null || isBaselineError(failed?.error)
  const liveVersion = rejectedLiveVersion ?? (baseline.data?.error ? baseline.data.liveVersion : failed?.liveVersion)
  const canPublish =
    !requested &&
    !busy && !pipelineBusy && baseline.data?.confirmation !== null &&
    !!baseline.data && !baseline.error &&
    (canConfirmDraft || canRetry || (!stopped && !blocked && batch.state === 'approved' && revision === batch.revision - 1 && !['publishing', 'published', 'failed', 'superseded', 'timed-out'].includes(run.data?.phase ?? '')))
  async function abandon() {
    const prepared = baseline.data?.prepared
    if (!prepared) return
    setBusy(true)
    setAbandonMessage('')
    try {
      await actions.abandon(id, batch.revision, prepared.commandId, abandonReason.trim())
      setAbandonMessage('Prepared Snapshot abandoned.')
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'unavailable'
      const messages: Record<string, string> = {
        locked: 'A live Publish run or lease owns this attempt. Wait for it to stop before abandoning.',
        version_taken: 'This Snapshot is committed or its version is already live. It cannot be abandoned.',
        superseded: 'This attempt changed. Refresh before abandoning.',
      }
      setAbandonMessage(messages[code] ?? 'Could not abandon this Snapshot. Refresh and try again.')
    } finally { setBusy(false) }
  }
  function openConfirmation() {
    const next = baseline.data?.confirmation
    setConfirmation(next ?? { revision: batch.revision, since: null, plateCount: 0, contributors: [] })
    setConfirmationMessage('')
    dialog.current?.showModal()
    void baseline.mutate?.().catch(() => undefined)
    if (next?.revision !== batch.revision) void detail.mutate?.().catch(() => undefined)
  }
  async function publish() {
    if (!confirmation || confirmation.revision !== batch.revision || pipelineBusy) return
    onPublish()
    setBusy(true)
    try {
      const result = await actions.publish(id, confirmation.revision)
      if (result.ok) {
        setRequestedFrom(run.data?.runId ?? null)
        setMessage('Publish requested. Waiting for the run…')
      } else if (result.code === 'superseded_revision' || result.code === PIPELINE_BUSY) {
        if (result.code === 'superseded_revision') {
          setConfirmationMessage(result.message)
          const next = result.confirmation ?? (await baseline.mutate())?.confirmation
          if (next) setConfirmation(next)
        }
        return
      } else {
        setMessage(result.message)
        if (result.liveVersion !== undefined) setRejectedLiveVersion(result.liveVersion)
      }
      dialog.current?.close()
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="min-w-0 space-y-6 rounded-3xl bg-card p-5">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs text-muted-foreground">CATALOG RELEASE</p>
          <h1 className="text-2xl font-extrabold">{batch.name}</h1>
          <p className="text-sm">{counts}</p>
        </div>
        {canPublish && (
          <Button variant="publish" onClick={openConfirmation}>
            {canRetry ? 'Publish again' : `Publish revision ${batch.revision}`}
          </Button>
        )}
      </header>
      <RunStatus batchId={id} />
      {pipelineBusy && <p role="status">{PIPELINE_BUSY_MESSAGE}</p>}
      {baseline.data?.retryReason === 'empty_batch' && <p role="status">This Batch has no changes to publish.</p>}
      {batch.state !== 'published' && !draftCanBeConfirmed(batch) && !canRetry && (batch.state !== 'approved' || revision !== batch.revision - 1) && <p role="alert">This Batch needs current approval. Review and approve it before publishing.</p>}
      {baseline.data?.abandonment && <p role="status">{baseline.data.abandonment.by.email} abandoned the prepared Snapshot at {new Date(baseline.data.abandonment.at).toLocaleString()}; burned v{baseline.data.abandonment.burnedVersion}.</p>}
      {baseline.data?.prepared && baseline.data.abandonReason !== 'locked' && <section className="space-y-3 rounded-2xl border p-4" aria-label="Prepared Snapshot recovery">
        <p>Prepared Snapshot v{baseline.data.prepared.toVersion}. Abandoning records disposition and permanently burns this version; Batch approval stays intact.</p>
        {baseline.data.canAbandon ? <>
          <label className="block">Reason for abandonment<input className="block w-full rounded border p-2" value={abandonReason} maxLength={1000} onChange={event => setAbandonReason(event.target.value)} /></label>
          <Button variant="outline" disabled={busy || !abandonReason.trim()} onClick={abandon}>Abandon prepared Snapshot</Button>
        </> : <p role="status">Abandon unavailable: {baseline.data.abandonReason === 'locked' ? 'A live Publish run or lease owns this attempt.' : 'This attempt cannot safely be abandoned. Refresh its status.'}</p>}
      </section>}
      {abandonMessage && <p role="status">{abandonMessage}</p>}
      {baseline.data?.stopped && !isPublishStop(failed?.error) && <p role="status">{PUBLISH_STOP_MESSAGES[baseline.data.stopped.reason]} The Catalog did not advance.{baseline.data.stopped.requestedBy ? ` Requested by ${baseline.data.stopped.requestedBy.email} (${baseline.data.stopped.requestedBy.uid}).` : ''}</p>}
      {isPublishStop(baseline.data?.error) && <p role="status">{PUBLISH_STOP_MESSAGES[baseline.data.error]}{baseline.data.error === PUBLISH_STOPS.paused ? ' Resume before requesting Publish.' : baseline.data.error === PUBLISH_STOPS.notEnabled ? ' An Owner must Resume publishing.' : ''}</p>}
      {batch.state === 'approved' && blocked && liveVersion !== undefined && (
        <CopyRecovery key={liveVersion} batch={batch} liveVersion={liveVersion} receiptConflict={receiptConflict} />
      )}
      {message &&
        (!requested ||
          !run.data?.phase ||
          run.data.phase === 'waiting-for-publish') && (
          <p role="status">{message}</p>
        )}
      <BatchChanges plates={plates} batch={batch} />
      <dialog
        ref={dialog}
        aria-labelledby="publish-title"
        className="m-auto max-w-lg space-y-4 rounded-3xl bg-card p-6 text-foreground backdrop:bg-[var(--scrim)]"
      >
        <h2 id="publish-title" className="text-xl font-bold">
          Publish {batch.name}?
        </h2>
        <p>
          Revision {confirmation?.revision ?? revision} {counts && `· ${counts}`}
        </p>
        {confirmation?.since === null && <p>You haven’t viewed this Batch in Review yet.</p>}
        {confirmation && confirmation.since !== null && confirmation.plateCount > 0 && (
          <p>
            {confirmation.plateCount} {confirmation.plateCount === 1 ? 'Plate changed' : 'Plates changed'} since you last viewed this Batch in Review.
            {confirmation.contributors.length > 0 && ` Changed by ${confirmation.contributors.join(', ')}.`}
          </p>
        )}
        {pipelineBusy && <p role="status">{PIPELINE_BUSY_MESSAGE}</p>}
        {!pipelineBusy && (confirmationMessage || revisionChanged) && <p role="status">{confirmationMessage || 'This Batch changed. Confirm the current revision.'}</p>}
        <p>This creates the next Catalog Snapshot.</p>
        <div className="flex flex-wrap justify-end gap-3">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </Button>
          {confirmation && confirmation.since !== null && confirmation.plateCount > 0 && (
            <Button asChild variant="outline">
              <Link href={`/review?batch=${encodeURIComponent(id)}&since=${confirmation.since}`}>Review new changes</Link>
            </Button>
          )}
          <Button variant="publish" disabled={busy || pipelineBusy || !confirmation || confirmation.revision !== batch.revision} onClick={publish}>
            {busy ? 'Requesting…' : confirmation?.plateCount ? 'Publish anyway' : `Publish revision ${confirmation?.revision ?? revision}`}
          </Button>
        </div>
      </dialog>
    </section>
  )
}

function OwnerWorkspace() {
  const requestedBatch = useSearchParams().get('batch')
  const control = usePublishControl()
  const batches = useBatches(['approved', 'published', 'open', 'submitted'])
  const [selection, setSelection] = useState<string | null>(null)
  const sorted = [...(batches.data ?? [])].sort((a, b) =>
    (b.approval?.at ?? b.createdAt).localeCompare(
      a.approval?.at ?? a.createdAt,
    ),
  )
  const approved = sorted.filter((batch) => batch.state === 'approved')
  const published = sorted.filter((batch) => batch.state === 'published')
  const drafts = sorted.filter(draftCanBeConfirmed)
  const firstId = approved[0]?.id ?? drafts[0]?.id ?? published[0]?.id
  const selected = selection ?? ([...approved, ...drafts].some(batch => batch.id === requestedBatch) ? requestedBatch : firstId)
  if (batches.error)
    return <p role="alert">Could not load Batches. Please refresh.</p>
  if (batches.isLoading) return <p role="status">Loading Batches…</p>
  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
      <aside className="space-y-4">
        <h1 className="text-2xl font-extrabold">Publish</h1>
        <PublishControlView control={control.data?.control ?? null} error={!!control.error} change={control.change} />
        <h2 className="font-bold">Approved Batches</h2>
        {!approved.length && (
          <p>
            No approved Batches yet.{' '}
            <Link href="/review" className="underline">
              Review
            </Link>
          </p>
        )}
        {approved.map((batch) => (
          <BatchItem
            key={batch.id}
            batch={batch}
            selected={batch.id === selected}
            onSelect={() => setSelection(batch.id)}
          />
        ))}
        {drafts.length > 0 && <>
          <h2 className="pt-4 font-bold">Draft Batches</h2>
          {drafts.map(batch => <BatchItem key={batch.id} batch={batch} selected={batch.id === selected} onSelect={() => setSelection(batch.id)} />)}
        </>}
        <h2 className="pt-4 font-bold">Published Batches</h2>
        {!published.length && (
          <p className="text-sm text-muted-foreground">
            No published Batches yet.
          </p>
        )}
        {published.map((batch) => (
          <BatchItem
            key={batch.id}
            batch={batch}
            selected={batch.id === selected}
            onSelect={() => setSelection(batch.id)}
          />
        ))}
      </aside>
      {selected && (
        <BatchSelection
          key={selected}
          id={selected}
          onPublish={() => setSelection(selected)}
        />
      )}
    </div>
  )
}

export function PublishWorkspace() {
  const me = useMe()
  if (me.error) return <p role="alert">Could not check your role.</p>
  if (!me.data) return <p role="status">Loading Publish…</p>
  return me.data.role === 'owner' ? (
    <OwnerWorkspace />
  ) : (
    <p>Only the Owner can Publish.</p>
  )
}
