'use client'

import Link from 'next/link'
import { useId, useRef, useState } from 'react'
import { IoArrowUpOutline, IoLayersOutline } from 'react-icons/io5'
import {
  isPublishStop,
  PIPELINE_BUSY,
  PUBLISH_STOPS,
  PUBLISH_STOP_MESSAGES,
} from '@/lib/publish/stop'
import { isBaselineError } from '@/lib/publish/baseline'
import {
  useDraftPublishView,
  useReviewActions,
  type DraftPublishView,
} from '@/lib/client/hooks'
import { batchHref } from '@/lib/review/href'
import { Button } from '@/components/ui/button'
import { RunStatus } from '@/components/review/run-status'

/** Name the Catalog the Publish writes to. */
function destinationLabel(destination: string | null) {
  return destination === 'license-plate-game-staging'
    ? 'Staging Catalog (license-plate-game-staging)'
    : (destination ?? 'configured Catalog')
}

/**
 * Explain why Publish is blocked, or return undefined when it is not. The pipeline-busy
 * case is rendered separately with its run count and a link to the runs.
 */
export function draftPublishBlocker(view: DraftPublishView) {
  if (view.canPublish) return undefined
  if (!view.enabledHere) return 'Publishing is disabled in this environment.'
  if (isPublishStop(view.error)) {
    const stop = PUBLISH_STOP_MESSAGES[view.error]
    return view.error === PUBLISH_STOPS.paused ||
      view.error === PUBLISH_STOPS.notEnabled
      ? `${stop} Use Resume publishing to allow new requests.`
      : stop
  }
  if (view.activeRelease)
    return `Publishing revision ${view.activeRelease.revision ?? '?'}. Wait for it to finish.`
  if (view.pipeline.busy) return PIPELINE_BUSY
  if (!view.states.length)
    return 'The draft has no changes to publish. Edit plates on the Dashboard.'
  if (view.approvalProblems.length)
    return 'Resolve the Standard plate issues below before publishing.'
  if (isBaselineError(view.error))
    return 'The Catalog changed since the draft was last read. Refresh to move the draft onto the current version.'
  return 'Publish is unavailable right now. Refresh to check again.'
}

/** Tell the Owner how many pipeline runs hold Publish and where to watch them. */
export function PipelineBusyNotice({ activeRuns }: { activeRuns?: number }) {
  return (
    <div role="status" className="space-y-1 rounded-2xl border p-3 text-sm">
      <p className="font-bold">Publish waits for the Plate Pipeline.</p>
      <p>
        {activeRuns === undefined
          ? 'Pipeline runs are queued or running.'
          : `${activeRuns} ${activeRuns === 1 ? 'run is' : 'runs are'} queued or running.`}{' '}
        Their results land in this draft, so Publish opens when they finish.
      </p>
      <Link className="underline" href="/?pipeline=open">
        Open pipeline runs
      </Link>
    </div>
  )
}

/**
 * The Owner's Publish view of the shared draft: the revision Publish will ship, what each
 * state changes and who changed it, the last publish, and why Publish is blocked when it
 * is. Publish ships every state together; edits made after the confirmed revision stay
 * in the draft for the next Publish.
 */
export function DraftPublish({ draftId }: { draftId: string }) {
  const view = useDraftPublishView(draftId)
  const actions = useReviewActions()
  const dialog = useRef<HTMLDialogElement>(null)
  const blockerId = useId()
  const [revision, setRevision] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  if (view.error && !view.data)
    return (
      <section className="space-y-3 rounded-3xl bg-card p-5">
        <p role="alert">Could not load the shared draft.</p>
        <Button variant="outline" onClick={() => void view.mutate()}>
          Refresh
        </Button>
      </section>
    )
  if (!view.data) return <p role="status">Loading the shared draft…</p>
  const data = view.data
  const blocker = draftPublishBlocker(data)
  const destination = destinationLabel(data.destination)
  const plates = data.states.reduce((sum, state) => sum + state.plates, 0)
  const last = data.lastPublish

  /** Capture the revision on screen and ask the Owner to confirm it. */
  function openConfirmation() {
    if (!data.canPublish) return
    setRevision(data.draftRevision)
    setMessage('')
    dialog.current?.showModal()
  }

  /** Publish the confirmed revision; later edits stay in the draft. */
  async function publish() {
    if (revision === null) return
    setBusy(true)
    try {
      const result = await actions.publish(draftId, revision)
      setMessage(
        result.ok
          ? `Publish requested for revision ${revision}. Waiting for the run…`
          : result.message
      )
      dialog.current?.close()
      void view.mutate()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden rounded-3xl bg-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold">Shared draft</h1>
          <p className="text-sm">
            Revision {data.draftRevision} · based on Catalog v
            {data.baselineVersion}
          </p>
          <p className="text-sm">Destination · {destination}</p>
          {data.liveVersion != null && (
            <p className="caption flex items-center gap-1.5">
              <IoLayersOutline aria-hidden="true" />
              Published catalog {data.liveVersion}
            </p>
          )}
          {last && (
            <p className="text-sm text-muted-foreground">
              Last published revision {last.revision} as v{last.version} by{' '}
              {last.byName || last.by} on {new Date(last.at).toLocaleString()}
            </p>
          )}
        </div>
        <div className="grid max-w-sm justify-items-start gap-2">
          <Button
            variant="publish"
            disabled={!data.canPublish || busy}
            aria-describedby={blocker ? blockerId : undefined}
            onClick={openConfirmation}
          >
            <IoArrowUpOutline aria-hidden="true" />
            Publish revision {data.draftRevision}
          </Button>
          {blocker && blocker !== PIPELINE_BUSY && (
            <p
              id={blockerId}
              role="status"
              className="text-sm text-muted-foreground"
            >
              {blocker}
            </p>
          )}
          {blocker === PIPELINE_BUSY && (
            <div id={blockerId}>
              <PipelineBusyNotice activeRuns={data.pipeline.activeRuns} />
            </div>
          )}
        </div>
      </header>
      <nav aria-label="Draft actions" className="flex flex-wrap gap-3">
        <Link className="underline" href="/review">
          Review unpublished changes
        </Link>
        <Button size="sm" variant="outline" onClick={() => void view.mutate()}>
          Refresh
        </Button>
      </nav>
      <div className="min-h-0 flex-1 space-y-3 lg:overflow-y-auto">
        {data.activeRelease && (
          <div className="space-y-2">
            <p role="status">
              Publishing revision {data.activeRelease.revision ?? '?'}.{' '}
              <Link
                className="underline"
                href={batchHref('/publish', data.activeRelease.id)}
              >
                Open release
              </Link>
            </p>
            <RunStatus compact batchId={data.activeRelease.id} />
          </div>
        )}
        {data.approvalProblems.length > 0 && (
          <div role="alert">
            <p>Resolve these Standard plate issues before publishing.</p>
            <ul className="list-disc pl-5">
              {data.approvalProblems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}
        {message && <p role="status">{message}</p>}
        <table className="w-full text-left text-sm">
          <caption className="pb-2 text-left font-bold">
            Changes by state · Publish ships every state together
          </caption>
          <thead>
            <tr className="text-muted-foreground">
              <th scope="col">State</th>
              <th scope="col">Plates changed</th>
              <th scope="col">Plates moved</th>
              <th scope="col">Changed by</th>
            </tr>
          </thead>
          <tbody>
            {data.states.map((state) => (
              <tr key={state.state} className="border-t">
                <th scope="row">
                  <Link
                    className="underline"
                    href={`/review?state=${encodeURIComponent(state.state)}`}
                  >
                    {state.state}
                  </Link>
                </th>
                <td>{state.plates}</td>
                <td>{state.moved}</td>
                <td>{state.contributors.join(', ') || '—'}</td>
              </tr>
            ))}
            {!data.states.length && (
              <tr className="border-t">
                <td colSpan={4} className="py-2 text-muted-foreground">
                  No unpublished changes.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <dialog
        ref={dialog}
        onClose={() => setRevision(null)}
        aria-labelledby="draft-publish-title"
        className="m-auto max-w-lg space-y-4 rounded-3xl bg-card p-6 text-foreground backdrop:bg-[var(--scrim)]"
      >
        <h2 id="draft-publish-title" className="text-xl font-bold">
          Publish revision {revision}?
        </h2>
        <p>
          {plates} {plates === 1 ? 'plate' : 'plates'} across{' '}
          {data.states.map((state) => state.state).join(', ')}.
        </p>
        {revision !== null && data.draftRevision > revision && (
          <p role="status">
            The draft moved to revision {data.draftRevision} since you opened
            this. Publish ships revision {revision}; the later edits stay in the
            draft.
          </p>
        )}
        <p>
          Edits saved after revision {revision} stay in the draft for the next
          Publish. This creates the next Snapshot for {destination}.
        </p>
        <div className="flex flex-wrap justify-end gap-3">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </Button>
          <Button variant="publish" disabled={busy} onClick={publish}>
            {busy ? 'Requesting…' : `Publish revision ${revision}`}
          </Button>
        </div>
      </dialog>
    </section>
  )
}
