'use client'

import { ApiError } from '@/lib/client/api'
import { isPublishStop, PIPELINE_BUSY, PIPELINE_BUSY_MESSAGE, PUBLISH_ERRORS, PUBLISH_STOPS, PUBLISH_STOP_MESSAGES } from '@/lib/publish/stop'
import { batchApprovedFor, draftCanBeConfirmed, hasDraftChanges } from '@/lib/publish/command'
import type { ReviewChanges } from '@/lib/review/checkpoint'
import { useId, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useBatchRevisionSignal } from '@/lib/client/live-signal'
import { canCopyForFreshReview } from '@/lib/review/access'
import { batchHref } from '@/lib/review/href'
import { BatchLastChanged } from '@/components/review/batch-last-changed'
import { IoArrowUpOutline, IoLayersOutline } from 'react-icons/io5'
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

/** Render a selectable batch with the workflow phase and date relevant to publishing. */
function BatchItem({
  batch,
  selected,
}: {
  batch: ReviewBatch
  selected: boolean
}) {
  const run = useBatchRun(batch.state === 'published' ? batch.id : null)
  const version = run.data?.outcome?.version
  const publishedAt = batch.state === 'published' ? run.data?.updatedAt : null
  const date = publishedAt ?? batch.approval?.at ?? batch.createdAt
  return (
    <Link
      href={batchHref('/publish', batch.id)}
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'block w-full rounded-2xl border p-4 text-left',
        selected ? 'border-primary bg-muted' : 'border-transparent bg-card',
      )}
    >
      {batch.state === 'published' ? (version == null ? <strong className="mb-2 block">Published</strong> : <span className="mb-2 block text-4xl font-extrabold tracking-tight">v{version}</span>) : <span className="mb-2 inline-block rounded-full bg-[var(--warning-tint)] text-[var(--warning-ink)] px-2 py-1 text-xs font-semibold">{batch.state === 'approved' ? 'Approved · waiting' : 'Draft'}</span>}
      <strong className="block">{batch.name}</strong>
      <span className="block text-sm text-muted-foreground">
        {batch.createdByName || 'Curator'}
      </span>
      <time dateTime={date} className="mt-2 block text-xs text-muted-foreground">
        {publishedAt ? 'Published' : batch.approval?.at ? 'Approved' : 'Created'} {new Date(date).toLocaleString()}
      </time>
    </Link>
  )
}

/**
 * Show the selected batch's proposed changes and its publish or release recovery
 * actions.
 */
function BatchSelection({
  id,
  pinBatch,
}: {
  id: string
  pinBatch: () => void
}) {
  const detail = useBatch(id)
  const run = useBatchRun(id)
  const baseline = usePublishBaseline(id)
  const actions = useReviewActions()
  const live = useBatchRevisionSignal(id, detail.data?.batch.revision ?? -1)
  const dialog = useRef<HTMLDialogElement>(null)
  const blockerId = useId()
  const [abandonReason, setAbandonReason] = useState('')
  const [abandonMessage, setAbandonMessage] = useState('')
  const [openedConfirmation, setConfirmation] = useState<ReviewChanges | null>(null)
  const [rejectedRevision, setRejectedRevision] = useState<number | null>(null)
  const [confirmationMessage, setConfirmationMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [requestedFrom, setRequestedFrom] = useState<string | null | undefined>(undefined)
  const [rejectedLiveVersion, setRejectedLiveVersion] = useState<number | null>(null)
  const groups = useMemo(() => groupChanges(detail.data?.plates ?? []), [detail.data])
  const reviewLink = batchHref('/review', id)
  const dashboardLink = batchHref('/', id)
  const refresh = () => Promise.allSettled([detail.mutate(), baseline.mutate(), run.mutate()])
  if (id === '' || detail.error) return (
    <section className="space-y-3 rounded-3xl bg-card p-5">
      <p role="alert">{id === '' || (detail.error instanceof ApiError && detail.error.status === 404) ? 'This Batch is unavailable.' : 'Could not load this Batch.'}</p>
      {id && <Button variant="outline" onClick={() => void refresh()}>Refresh Batch</Button>}
      <Link className="block underline" href="/publish">Choose another Batch</Link>
    </section>
  )
  if (!detail.data) return <p role="status">Loading Batch…</p>
  const { batch, plates } = detail.data
  const preflight = baseline.data
  const latestConfirmation = preflight?.confirmation
  const confirmationCurrent = preflight?.batchRevision === batch.revision && latestConfirmation?.revision === batch.revision
  const confirmation = openedConfirmation && confirmationCurrent && latestConfirmation.revision > openedConfirmation.revision
    ? latestConfirmation
    : openedConfirmation
  const revisionChanged = !!openedConfirmation && (
    batch.revision !== openedConfirmation.revision ||
    !!latestConfirmation && latestConfirmation.revision > openedConfirmation.revision ||
    rejectedRevision === openedConfirmation.revision
  )
  const counts = Object.entries(groups)
    .filter(([, entries]) => entries.length > 0)
    .map(([name, entries]) => `${entries.length} ${name.toLowerCase()}`)
    .join(', ')
  const empty = preflight?.retryReason === 'empty_batch' || !hasDraftChanges(batch, plates.flatMap(plate => plate.edit ? [plate.edit.fields] : []))
  const draft = draftCanBeConfirmed(batch)
  const approved = batchApprovedFor(batch, { batchId: id, revision: batch.revision })
  const published = batch.state === 'published'
  const pipelineBusy = preflight?.pipelineBusy === true
  const failed = approved ? run.data?.outcome : undefined
  const stopped = isPublishStop(failed?.error) || !!preflight?.stopped
  const canRetry = preflight?.canRetry === true
  const catalogVersion = preflight?.liveVersion ?? (published ? run.data?.outcome?.version : undefined)
  const requested = requestedFrom !== undefined && requestedFrom === (run.data?.runId ?? null)
  const receiptConflict = preflight?.error === BASELINE_ERRORS.receiptConflict || failed?.error === BASELINE_ERRORS.receiptConflict
  const liveVersion = rejectedLiveVersion ?? (isBaselineError(preflight?.error) ? preflight.liveVersion : isBaselineError(failed?.error) ? failed.liveVersion : undefined)
  const stale = isBaselineError(preflight?.error) || rejectedLiveVersion !== null || isBaselineError(failed?.error)
  const canPublish = confirmationCurrent && !published && !requested && !busy && !empty &&
    !pipelineBusy && !stale && !preflight.error && !baseline.error && preflight.enabledHere &&
    (draft || run.data?.phase !== 'publishing') &&
    (preflight.canConfirmDraft || approved && (canRetry || !stopped && preflight.retryReason === PUBLISH_ERRORS.notWaiting && run.data?.phase === 'waiting-for-publish'))
  const canSend = !!confirmation && canPublish && confirmation.revision === batch.revision && confirmation.revision !== rejectedRevision
  let blocker: string | undefined
  if (!published && !canPublish) {
    if (preflight?.enabledHere === false) blocker = 'Publishing is disabled in this environment.'
    else if (baseline.error) blocker = 'Could not check whether this Batch can publish. Refresh Batch to try again.'
    else if (isPublishStop(preflight?.error)) {
      blocker = PUBLISH_STOP_MESSAGES[preflight.error]
      if (preflight.error === PUBLISH_STOPS.paused || preflight.error === PUBLISH_STOPS.notEnabled) blocker += ' Use Resume publishing to allow new requests.'
    } else if (pipelineBusy) blocker = PIPELINE_BUSY_MESSAGE
    else if (requested || busy || run.data?.phase === 'publishing' || preflight?.retryReason === 'locked') blocker = 'A Publish attempt is in progress.'
    else if (empty) blocker = 'This Batch has no changes to publish. Choose another Batch or edit it on the Dashboard.'
    else if (!draft && !approved) blocker = 'Reopen this Batch on the Dashboard before publishing.'
    else if (preflight?.approvalProblems?.length) blocker = 'Resolve the Standard plate issues below before publishing.'
    else if (stale) blocker = receiptConflict ? 'A prepared Snapshot conflicts with this Batch. See recovery below.'
      : 'This Batch is based on an older catalog. Copy it to the current version before publishing.'
    else if (!confirmationCurrent) blocker = 'Checking the current Batch for Publish…'
    else blocker = 'Publish is unavailable for this Batch. Refresh Batch to check its status.'
  }
  const destination = preflight?.destination === 'license-plate-game-staging' ? 'Staging Catalog (license-plate-game-staging)' : preflight?.destination ?? 'configured Catalog'
  /**
   * Request abandonment of the prepared receipt identified by the current baseline
   * status.
   */
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
  /**
   * Open the publish confirmation using the current command and refresh the eligibility
   * evidence.
   */
  function openConfirmation() {
    if (!canPublish || !latestConfirmation) return
    pinBatch()
    setConfirmation(latestConfirmation)
    setConfirmationMessage('')
    dialog.current?.showModal()
    void refresh()
  }

  /**
   * Send the confirmed publish command and reconcile any new eligibility or revision
   * returned by the server.
   */
  async function publish() {
    if (!canSend || !confirmation) return
    setBusy(true)
    try {
      const result = await actions.publish(id, confirmation.revision)
      if (result.ok) {
        setRequestedFrom(run.data?.runId ?? null)
        setMessage('Publish requested. Waiting for the run…')
      } else if (result.code === 'superseded_revision' || result.code === PIPELINE_BUSY) {
        if (result.code === 'superseded_revision') setRejectedRevision(confirmation.revision)
        setConfirmationMessage(result.message)
        void refresh()
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
    <section className="flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden rounded-3xl bg-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold">{batch.name}</h1>
          <p className="text-sm text-muted-foreground"><BatchLastChanged batch={batch} /></p>
          {!published && preflight && <p className="text-sm">Destination · {destination}</p>}
          {catalogVersion != null && (
            <p className="caption flex items-center gap-1.5"><IoLayersOutline aria-hidden="true" />Published catalog {catalogVersion}</p>
          )}
          {counts && <p className="text-sm">{counts}</p>}
        </div>
        {!published && <div className="grid max-w-sm justify-items-start gap-2">
          <Button variant="publish" disabled={!canPublish} aria-describedby={blocker ? blockerId : undefined} onClick={openConfirmation}>
            <IoArrowUpOutline aria-hidden="true" />{canPublish && canRetry ? 'Publish again' : 'Publish to Game'}
          </Button>
          {blocker && <p id={blockerId} role="status" className="text-sm text-muted-foreground">{blocker}</p>}
        </div>}
      </header>
      <nav aria-label="Batch actions" className="flex flex-wrap items-center gap-3">
        <Link className="underline" href={reviewLink}>Review Batch</Link>
        {!published && <Link className="underline" href={dashboardLink}>Open Batch on Dashboard</Link>}
        {!published && <Button size="sm" variant="outline" onClick={() => { setRejectedLiveVersion(null); void refresh() }}>Refresh Batch</Button>}
      </nav>
      {!published && live === 'Live updates unavailable' && <p role="status">Live updates unavailable. Refresh Batch to check for changes.</p>}
      <div className="min-h-0 flex-1 space-y-3 lg:overflow-y-auto">
        <RunStatus compact batchId={id} />
        {!published && preflight?.approvalProblems?.length ? <div role="alert">
          <p>Resolve these Standard plate issues before publishing.</p>
          <ul className="list-disc pl-5">{preflight.approvalProblems.map(problem => <li key={problem}>{problem}</li>)}</ul>
        </div> : null}
        {approved && !empty && !stopped && !stale && !pipelineBusy && preflight?.enabledHere && !preflight.error && preflight.retryReason === PUBLISH_ERRORS.notWaiting && run.data && !['waiting-for-publish', 'publishing'].includes(run.data.phase ?? '') && (
          <p role="status">The approval run is no longer waiting for Publish. Refresh Batch to check its status.</p>
        )}
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
        {!empty && stale && !isPublishStop(preflight?.error) && liveVersion !== undefined && canCopyForFreshReview(batch, liveVersion) && (
          <CopyRecovery key={liveVersion} batch={batch} liveVersion={liveVersion} receiptConflict={receiptConflict} />
        )}
        {message &&
          (!requested ||
            !run.data?.phase ||
            run.data.phase === 'waiting-for-publish') && (
            <p role="status">{message}</p>
          )}
        <BatchChanges plates={plates} batch={batch} />
      </div>
      <dialog
        ref={dialog}
        onClose={() => setConfirmation(null)}
        aria-labelledby="publish-title"
        className="m-auto max-w-lg space-y-4 rounded-3xl bg-card p-6 text-foreground backdrop:bg-[var(--scrim)]"
      >
        <h2 id="publish-title" className="text-xl font-bold">
          Publish {batch.name}?
        </h2>
        <p>
          Revision {confirmation?.revision ?? batch.revision} {counts && `· ${counts}`}
        </p>
        {confirmation?.since === null && <p>You haven’t viewed this Batch in Review yet.</p>}
        {confirmation && confirmation.since !== null && confirmation.plateCount > 0 && (
          <p>
            {confirmation.plateCount} {confirmation.plateCount === 1 ? 'Plate changed' : 'Plates changed'} since you last viewed this Batch in Review.
            {confirmation.contributors.length > 0 && ` Changed by ${confirmation.contributors.join(', ')}.`}
          </p>
        )}
        {openedConfirmation && pipelineBusy && <p role="status">{PIPELINE_BUSY_MESSAGE}</p>}
        {revisionChanged && <p role="status">This Batch changed. Review the latest changes and confirm the current revision.</p>}
        {!revisionChanged && confirmationMessage && <p role="status">{confirmationMessage}</p>}
        {openedConfirmation && !canPublish && !busy && !pipelineBusy && <p role="status">Publish is unavailable for the current Batch. Check its status before confirming.</p>}
        <p>{approved ? 'This uses the current Owner approval.' : 'Confirm these draft changes for release.'}</p>
        <p>This creates the next Snapshot for {destination}.</p>
        <div className="flex flex-wrap justify-end gap-3">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </Button>
          {confirmation && confirmation.since !== null && confirmation.plateCount > 0 ? (
            <Button asChild variant="outline">
              <Link href={`${reviewLink}&since=${confirmation.since}`}>Review new changes</Link>
            </Button>
          ) : revisionChanged ? <Button asChild variant="outline"><Link href={reviewLink}>Review Batch</Link></Button> : null}
          <Button variant="publish" disabled={!canSend} onClick={publish}>
            {busy ? 'Requesting…' : confirmation?.plateCount ? 'Publish anyway' : `Publish revision ${confirmation?.revision ?? batch.revision}`}
          </Button>
        </div>
      </dialog>
    </section>
  )
}

/** Load owner release controls and select a batch from the URL or workspace list. */
function OwnerWorkspace() {
  const requestedBatch = useSearchParams().get('batch')
  const control = usePublishControl()
  const batches = useBatches(['approved', 'published', 'open', 'submitted'])
  const router = useRouter()
  const [pinnedBatch, setPinnedBatch] = useState<string | null>(null)
  const sorted = [...(batches.data ?? [])].sort((a, b) =>
    (b.approval?.at ?? b.createdAt).localeCompare(
      a.approval?.at ?? a.createdAt,
    ),
  )
  const approved = sorted.filter((batch) => batch.state === 'approved')
  const published = sorted.filter((batch) => batch.state === 'published')
  const drafts = sorted.filter(draftCanBeConfirmed)
  const firstId = approved[0]?.id ?? drafts[0]?.id ?? published[0]?.id
  const selected = requestedBatch ?? pinnedBatch ?? firstId
  return (
    <div className="grid gap-4 lg:h-[calc(100dvh-var(--header-h)-var(--space-6)*2)] lg:grid-cols-[minmax(220px,272px)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
      <aside className="min-h-0 space-y-2 lg:overflow-y-auto lg:pr-2">
        <h1 className="text-2xl font-extrabold">Publish</h1>
        <PublishControlView control={control.data?.control ?? null} enabledHere={control.data?.enabledHere} loading={control.isLoading} error={!!control.error} change={control.change} />
        {batches.error && <p role="alert">Could not load the Batch list.</p>}
        {batches.isLoading && <p role="status">Loading Batches…</p>}
        {approved.length > 0 && <h2 className="font-bold">Approved Batches</h2>}
        {approved.map((batch) => (
          <BatchItem
            key={batch.id}
            batch={batch}
            selected={batch.id === selected}
          />
        ))}
        {drafts.length > 0 && <>
          <h2 className="pt-4 font-bold">Draft Batches</h2>
          {drafts.map(batch => <BatchItem key={batch.id} batch={batch} selected={batch.id === selected} />)}
        </>}
        {published.length > 0 && <h2 className="pt-2 font-bold">Published Batches</h2>}
        {!selected && <p className="caption">No Batches to publish. <Link href="/review" className="underline">Review</Link></p>}
        {published.map((batch) => (
          <BatchItem
            key={batch.id}
            batch={batch}
            selected={batch.id === selected}
          />
        ))}
      </aside>
      {selected !== undefined && (
        <BatchSelection
          key={selected}
          id={selected}
          pinBatch={() => {
            if (requestedBatch !== null) return
            setPinnedBatch(selected)
            router.replace(batchHref('/publish', selected), { scroll: false })
          }}
        />
      )}
    </div>
  )
}

/** Check owner access before rendering the publish workspace. */
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
