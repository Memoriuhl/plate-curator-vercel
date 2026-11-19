'use client'

import Link from 'next/link'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  IoArrowForward,
  IoArrowUpOutline,
  IoCheckmarkCircleOutline,
  IoInformationCircleOutline,
  IoSearchOutline,
} from 'react-icons/io5'
import {
  isPublishStop,
  PIPELINE_BUSY,
  PUBLISH_STOPS,
  PUBLISH_STOP_MESSAGES,
} from '@/lib/publish/stop'
import { isBaselineError } from '@/lib/publish/baseline'
import {
  useBatch,
  useDraftPublishView,
  useMe,
  useReviewActions,
  type DraftPublishView,
} from '@/lib/client/hooks'
import { batchHref } from '@/lib/review/href'
import { publishChanges, type PublishFilter } from '@/lib/review/plate-changes'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/toggle'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { cn } from '@/components/utils'
import { DraftChanges } from './draft-changes'
import { RunStatus } from '@/components/review/run-status'
import {
  PipelineFieldValue,
  pipelineFieldLabel,
} from '@/components/dashboard/pipeline-field-value'
import type { DraftConflict } from '@/lib/review/types'

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
  if (view.interruptedRelease)
    return `Revision ${view.interruptedRelease.revision ?? '?'} stopped after preparing its Snapshot. Open that release to retry or abandon it.`
  if (view.conflicts?.length)
    return 'Changes made outside this draft touched values it would publish. Check the conflicts below.'
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

/** Describe one conflict in plain words. */
export function conflictLabel(conflict: DraftConflict) {
  if (conflict.kind === 'order')
    return `${conflict.state} plate order: Catalog v${conflict.toVersion} changed it after v${conflict.fromVersion}.`
  if (conflict.kind === 'deleted')
    return `${conflict.plateId}: Catalog v${conflict.toVersion} deleted this plate after its deletion was undone here.`
  if (conflict.kind === 'removed')
    return `${conflict.plateId}: Catalog v${conflict.toVersion} removed this plate, so its pending ${Object.keys(conflict.fields).join(', ')} cannot be published.`
  if (conflict.kind === 'catalog')
    return `Catalog moved from v${conflict.fromVersion} to v${conflict.toVersion} in a way the publish receipts cannot trace, so the draft stays on v${conflict.fromVersion} until you review it.`
  return `${conflict.plateId} · ${conflict.field}: Catalog v${conflict.toVersion} changed it after v${conflict.fromVersion}.`
}

/** A stable list key for one conflict. */
function conflictKey(conflict: DraftConflict) {
  if (conflict.kind === 'order') return `order:${conflict.state}`
  if (conflict.kind === 'catalog')
    return `catalog:${conflict.fromVersion}:${conflict.toVersion}`
  if (conflict.kind === 'field')
    return `field:${conflict.plateId}:${conflict.field}`
  return `${conflict.kind}:${conflict.plateId}`
}

/** The pending values of a plate the catalog removed, which keeping the draft omits. */
function OmittedValues({
  fields,
}: {
  fields: Extract<DraftConflict, { kind: 'removed' }>['fields']
}) {
  return (
    <div className="mt-1 space-y-1">
      <p>These edits will be omitted if you keep the draft&apos;s values:</p>
      <dl className="grid gap-1">
        {Object.entries(fields).map(([field, value]) => (
          <div key={field}>
            <dt className="caption">{pipelineFieldLabel(field)}</dt>
            <dd>
              <PipelineFieldValue field={field} value={value} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/**
 * The values the draft put back after a revision that may have published. Keeping the
 * draft's values keeps them, and the next Publish ships them, because live may now hold
 * the published value.
 */
function PutBacks({
  conflict,
}: {
  conflict: Extract<DraftConflict, { kind: 'catalog' }>
}) {
  const orders = Object.entries(conflict.orderResets ?? {})
  if (!conflict.resets?.length && !orders.length) return null
  return (
    <div className="mt-1 space-y-1">
      <p>
        The draft put these back after a revision that may have published.
        Keeping the draft&apos;s values keeps them, and the next Publish ships
        them:
      </p>
      <dl className="grid gap-1">
        {conflict.resets?.map((reset) => (
          <div key={reset.plateId}>
            <dt className="font-bold">{reset.plateId}</dt>
            {Object.entries(reset.fields).map(([field, value]) => (
              <dd key={field}>
                <span className="caption">{pipelineFieldLabel(field)}</span>
                <PipelineFieldValue field={field} value={value} />
              </dd>
            ))}
          </div>
        ))}
        {orders.map(([state, order]) => (
          <div key={state}>
            <dt className="font-bold">{state} plate order</dt>
            <dd>{order.join(', ')}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** Name what keeping the draft's values does beyond keeping them. */
function keepLabel(conflicts: DraftConflict[]) {
  const effects = [
    ...(conflicts.some(
      (conflict) =>
        conflict.kind === 'catalog' &&
        (conflict.resets?.length ||
          Object.keys(conflict.orderResets ?? {}).length)
    )
      ? ['keep the put-backs for the next Publish']
      : []),
    ...(conflicts.some((conflict) => conflict.kind === 'removed')
      ? ["omit the removed plates' edits"]
      : []),
  ]
  return ["Keep the draft's values", ...effects].join(' and ')
}

/**
 * List the pending values an outside catalog change touched. Changing or discarding a
 * value clears its conflict; the Owner can instead keep every draft value as it is,
 * which omits the pending values of plates the catalog removed and, after a span the
 * receipts cannot trace, publishes the values the draft put back.
 */
export function DraftConflicts({
  draftId,
  revision,
  conflicts,
  onChange,
}: {
  draftId: string
  revision: number
  conflicts: DraftConflict[]
  onChange: () => void
}) {
  const actions = useReviewActions()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  /** Keep the draft's values for the revision on screen. */
  async function keep() {
    setBusy(true)
    try {
      const result = await actions.keepDraftValues(draftId, revision)
      setMessage(result.ok ? '' : result.message)
      onChange()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="alert" className="space-y-2 rounded-2xl border p-3 text-sm">
      <p className="font-bold">
        The live Catalog changed values this draft would publish.
      </p>
      <p>
        Publishing now would replace those changes. Edit or discard each value
        in Review, or keep the draft&apos;s values if you checked them.
      </p>
      <ul className="list-disc pl-5">
        {conflicts.map((conflict) => {
          const state =
            conflict.kind === 'order'
              ? conflict.state
              : conflict.kind === 'catalog'
                ? null
                : conflict.plateId.split('.')[0]
          return (
            <li key={conflictKey(conflict)}>
              {conflictLabel(conflict)}{' '}
              {state && conflict.kind !== 'removed' && (
                <Link
                  className="underline"
                  href={`/review?state=${encodeURIComponent(state)}`}
                >
                  Review {state}
                </Link>
              )}
              {conflict.kind === 'removed' && (
                <OmittedValues fields={conflict.fields} />
              )}
              {conflict.kind === 'catalog' && <PutBacks conflict={conflict} />}
            </li>
          )
        })}
      </ul>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void keep()}
      >
        {keepLabel(conflicts)}
      </Button>
      {message && <p role="status">{message}</p>}
    </div>
  )
}
const FILTERS: { value: PublishFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'edited', label: 'Edited' },
  { value: 'moved', label: 'Moved' },
  { value: 'removed', label: 'Removed' },
]

/** What the players' app has now and which draft revision Publish would send it. */
function VersionChange({
  live,
  revision,
}: {
  live?: number
  revision: number
}) {
  return (
    <div className="flex items-center gap-4 rounded-[var(--radius-lg)] bg-card px-5 py-3.5">
      <p className="grid gap-0.5">
        <span className="label text-[var(--ink-2)]">Players have</span>
        <span className="font-mono text-[28px] leading-8">
          {live == null ? '—' : `v${live}`}
        </span>
      </p>
      <IoArrowForward aria-label="then" className="size-6 shrink-0" />
      <p className="grid gap-0.5">
        <span className="label text-info">Will get</span>
        <span className="font-mono text-[28px] leading-8 text-info">
          {`revision ${revision}`}
        </span>
      </p>
    </div>
  )
}

/** A passed Publish check, in plain words. */
function Check({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2.5 text-sm leading-5 font-bold">
      <IoCheckmarkCircleOutline
        aria-hidden="true"
        className="size-5 shrink-0 text-[var(--success)]"
      />
      {children}
    </li>
  )
}

/**
 * The Owner's Publish view of the shared draft: every changed plate by state with an
 * icon per change, and a side panel with the counts, the checks that passed, who
 * changed what and the Publish button. Publish ships every state together; edits made
 * after the confirmed revision stay in the draft for the next Publish. `side` holds the
 * workspace's publishing control and history.
 */
export function DraftPublish({
  draftId,
  side,
}: {
  draftId: string
  side?: ReactNode
}) {
  const view = useDraftPublishView(draftId)
  const detail = useBatch(draftId)
  const me = useMe()
  const actions = useReviewActions()
  const dialog = useRef<HTMLDialogElement>(null)
  const blockerId = useId()
  const [revision, setRevision] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [filter, setFilter] = useState<PublishFilter>('all')
  const [query, setQuery] = useState('')
  const changes = useMemo(
    () => publishChanges(detail.data?.plates ?? []),
    [detail.data]
  )
  const entries = useMemo(
    () =>
      new Map(
        (detail.data?.plates ?? []).map((entry) => [entry.baseline.id, entry])
      ),
    [detail.data]
  )
  // The list is read once; reread it when the polled view shows a newer revision.
  const draftRevision = view.data?.draftRevision
  const listedRevision = detail.data?.batch.revision
  const refreshList = detail.mutate
  useEffect(() => {
    if (
      draftRevision != null &&
      listedRevision != null &&
      listedRevision < draftRevision
    )
      void refreshList()
  }, [draftRevision, listedRevision, refreshList])

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

  /** The changed plates, or why they are not shown yet. */
  function changedPlates() {
    if (!data.states.length)
      return <p className="body text-[var(--ink-2)]">No unpublished changes.</p>
    if (detail.error && !detail.data)
      return (
        <p role="alert" className="body">
          Could not load the changed plates.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => void detail.mutate()}
          >
            Try again
          </button>
        </p>
      )
    if (!detail.data) return <p role="status">Loading the changed plates…</p>
    return (
      <DraftChanges
        states={changes.states}
        entries={entries}
        batch={detail.data.batch}
        filter={filter}
        query={query}
        viewer={me.data?.uid}
      />
    )
  }

  const counts = changes.counts
  return (
    <div className="grid min-w-0 gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="page-title">Publish to players</h1>
          <p className="body">
            Revision {data.draftRevision} · based on Catalog v
            {data.baselineVersion}
          </p>
          <p className="caption text-[var(--ink-2)]">
            Destination · {destination}
          </p>
          {last && (
            <p className="caption text-[var(--ink-2)]">
              Last published revision {last.revision} as v{last.version} by{' '}
              {last.byName || last.by} on {new Date(last.at).toLocaleString()}
            </p>
          )}
        </div>
        <VersionChange live={data.liveVersion} revision={data.draftRevision} />
      </header>
      <div className="flex flex-wrap items-start gap-5">
        <section
          aria-label="Changed plates"
          className="flex min-w-0 flex-[999_1_560px] flex-col gap-[var(--stack-gap)] rounded-3xl bg-card p-4"
        >
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
          {data.interruptedRelease && (
            <p role="status">
              Revision {data.interruptedRelease.revision ?? '?'} stopped after
              preparing its Snapshot.{' '}
              <Link
                className="underline"
                href={batchHref('/publish', data.interruptedRelease.id)}
              >
                Open release
              </Link>{' '}
              to retry or abandon it.
            </p>
          )}
          {!!data.conflicts?.length && (
            <DraftConflicts
              draftId={draftId}
              revision={data.draftRevision}
              conflicts={data.conflicts}
              onChange={() => void view.mutate()}
            />
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
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-h-10 flex-[1_1_260px] items-center gap-2 rounded-[var(--radius-pill)] bg-[var(--fill)] px-3.5">
              <IoSearchOutline
                aria-hidden="true"
                className="size-4 shrink-0 text-[var(--ink-2)]"
              />
              <input
                type="search"
                aria-label="Search changing plates"
                placeholder="Search changing plates by name, id, state or change"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="body min-w-0 flex-1 bg-transparent outline-none"
              />
            </label>
            {FILTERS.map(({ value, label }) => (
              <Toggle
                key={value}
                variant="inset"
                pressed={filter === value}
                onPressedChange={() => setFilter(value)}
                count={counts[value]}
              >
                {label}{' '}
              </Toggle>
            ))}
          </div>
          <nav aria-label="Draft actions" className="flex flex-wrap gap-3">
            <Link className="label underline" href="/review">
              Review unpublished changes
            </Link>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void view.mutate()
                void detail.mutate()
              }}
            >
              Refresh
            </Button>
          </nav>
          {changedPlates()}
        </section>
        <aside
          aria-label="Publish summary"
          className="flex min-w-0 flex-[1_1_300px] flex-col gap-4 rounded-3xl bg-card p-5 lg:max-w-[360px]"
        >
          <div className="grid grid-cols-3 gap-2">
            {(['edited', 'moved', 'removed'] as const).map((kind) => (
              <p
                key={kind}
                className="grid rounded-[var(--radius-md)] bg-[var(--fill)] p-3"
              >
                <span
                  className={cn(
                    'font-mono text-[28px] leading-8',
                    counts[kind] ? 'text-info' : 'text-[var(--ink-2)]'
                  )}
                >
                  {counts[kind]}
                </span>
                <span className="label">{kind}</span>
              </p>
            ))}
          </div>
          <ul className="m-0 grid list-none gap-3 p-0">
            {data.liveVersion != null &&
              data.baselineVersion === data.liveVersion && (
                <Check>
                  Built on Catalog v{data.liveVersion}, the version players
                  have, so nothing they have is rolled back.
                </Check>
              )}
            {!data.conflicts?.length && (
              <Check>No conflicts with the live Catalog.</Check>
            )}
            {!data.pipeline.busy && (
              <Check>
                The Plate Pipeline is idle, so no results are still landing.
              </Check>
            )}
            {!data.approvalProblems.length && (
              <Check>No Standard plate issues.</Check>
            )}
          </ul>
          {changes.authors.length > 0 && (
            <div className="grid gap-2 border-t border-[var(--hairline)] pt-3.5">
              <p className="label text-[var(--ink-2)]">Changed by</p>
              <ul className="m-0 grid list-none gap-2 p-0">
                {changes.authors.map((author) => (
                  <li
                    key={author.uid}
                    className="flex items-center gap-2 text-sm font-bold"
                  >
                    <Avatar
                      size="sm"
                      player={author.uid === me.data?.uid ? 'you' : 'friend'}
                      aria-hidden="true"
                    >
                      <AvatarFallback>
                        {author.name.trim().slice(0, 1).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    {`${author.name} · ${author.plates} ${author.plates === 1 ? 'plate' : 'plates'}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {side && (
            <div className="grid gap-3 border-t border-[var(--hairline)] pt-3.5">
              {side}
            </div>
          )}
          <div className="grid gap-2 border-t border-[var(--hairline)] pt-4">
            <p className="flex gap-2 rounded-[var(--radius-md)] bg-[var(--warning-tint)] p-2.5 text-[13px] leading-[18px] font-bold text-[var(--warning-ink)]">
              <IoInformationCircleOutline
                aria-hidden="true"
                className="size-[18px] shrink-0"
              />
              Edits saved after revision {data.draftRevision} stay in the draft
              for the next Publish.
            </p>
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
            <Button
              variant="publish"
              className="h-12 text-base"
              disabled={!data.canPublish || busy}
              aria-describedby={blocker ? blockerId : undefined}
              onClick={openConfirmation}
            >
              <IoArrowUpOutline aria-hidden="true" />
              Publish revision {data.draftRevision}
            </Button>
          </div>
        </aside>
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
    </div>
  )
}
