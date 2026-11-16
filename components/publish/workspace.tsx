'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import {
  useBatch,
  useBatches,
  useBatchRun,
  useMe,
  useReviewActions,
} from '@/lib/client/hooks'
import type { ReviewBatch } from '@/lib/review/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/components/utils'
import {
  changeSummary,
  DiffTable,
  groupChanges,
} from '@/components/review/diff'
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
  const detail = useBatch(batch.id)
  const run = useBatchRun(batch.state === 'published' ? batch.id : null)
  const groups = detail.data ? groupChanges(detail.data.plates) : null
  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full rounded-2xl border p-4 text-left',
        selected ? 'border-primary bg-muted' : 'border-border',
      )}
    >
      <strong className="block">{batch.name}</strong>
      <span className="block text-sm text-muted-foreground">
        {batch.createdByName || 'Curator'} · revision{' '}
        {batch.approval?.revision ?? batch.revision}
      </span>
      {batch.approval?.at && (
        <time className="block text-xs">
          Approved {new Date(batch.approval.at).toLocaleString()}
        </time>
      )}
      {groups && (
        <span className="mt-2 block text-xs">
          {Object.entries(groups)
            .map(([name, entries]) => `${entries.length} ${name.toLowerCase()}`)
            .join(' · ')}
        </span>
      )}
      {batch.state === 'published' && (
        <span className="mt-2 block font-bold">
          Published · v{run.data?.outcome?.version ?? '·'}
        </span>
      )}
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
  const actions = useReviewActions()
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [requested, setRequested] = useState(false)
  if (detail.error) return <p role="alert">Could not load this Batch.</p>
  if (!detail.data) return <p role="status">Loading Batch…</p>
  const { batch, plates } = detail.data
  const groups = groupChanges(plates)
  const counts = Object.entries(groups)
    .map(([name, entries]) => `${entries.length} ${name.toLowerCase()}`)
    .join(', ')
  const revision = batch.approval?.revision
  const canPublish =
    batch.state === 'approved' &&
    revision !== undefined &&
    !requested &&
    !['publishing', 'published', 'failed', 'superseded', 'timed-out'].includes(
      run.data?.phase ?? '',
    )
  async function publish() {
    if (revision === undefined) return
    onPublish()
    setBusy(true)
    try {
      const result = await actions.publish(id, revision)
      if (result.ok) {
        setRequested(true)
        setMessage('Publish requested. Waiting for the run·')
      } else setMessage(result.message)
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
          <Button variant="publish" onClick={() => dialog.current?.showModal()}>
            Publish revision {revision}
          </Button>
        )}
      </header>
      <RunStatus batchId={id} />
      {message &&
        (!requested ||
          !run.data?.phase ||
          run.data.phase === 'waiting-for-publish') && (
          <p role="status">{message}</p>
        )}
      {Object.entries(groups).map(([name, entries]) => (
        <section key={name} className="space-y-3">
          <h2 className="text-lg font-bold">
            {name}{' '}
            <span className="text-muted-foreground">{entries.length}</span>
          </h2>
          {!entries.length && (
            <p className="text-sm text-muted-foreground">
              No {name.toLowerCase()} changes.
            </p>
          )}
          {Object.entries(
            name === 'Reordered'
              ? Object.groupBy(entries, (entry) => entry.baseline.state)
              : { all: entries },
          ).map(([state, stateEntries]) => (
            <div key={state} className="space-y-3">
              {name === 'Reordered' && (
                <h3 className="font-semibold">{state}</h3>
              )}
              {stateEntries?.map((entry) => (
                <details
                  key={entry.baseline.id}
                  className="rounded-2xl border border-border p-3"
                >
                  <summary className="cursor-pointer">
                    <strong>{entry.proposed.displayName}</strong>
                    <span className="ml-2 text-sm text-muted-foreground">
                      {name === 'Reordered'
                        ? `${entry.baseline.state}: moved from ${(entry.order?.before ?? entry.baseline.sortOrder ?? 0) + 1} to ${(entry.order?.after ?? entry.proposed.sortOrder ?? 0) + 1}`
                        : changeSummary(
                            entry.baseline,
                            entry.proposed,
                            undefined,
                            name as 'Edited' | 'Regrouped',
                          )}
                    </span>
                  </summary>
                  <DiffTable
                    before={entry.baseline}
                    after={entry.proposed}
                    version={batch.baselineVersion}
                    revision={batch.revision}
                    positions={entry.order}
                    order={batch.stateOrders[entry.baseline.state] ?? []}
                  />
                </details>
              ))}
            </div>
          ))}
        </section>
      ))}
      <dialog
        ref={dialog}
        aria-labelledby="publish-title"
        className="m-auto max-w-lg space-y-4 rounded-3xl bg-card p-6 text-foreground backdrop:bg-black/50"
      >
        <h2 id="publish-title" className="text-xl font-bold">
          Publish {batch.name}?
        </h2>
        <p>
          Revision {revision} · {counts}
        </p>
        <p>This creates the next Catalog Snapshot.</p>
        <div className="flex justify-end gap-3">
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

function OwnerWorkspace() {
  const batches = useBatches(['approved', 'published'])
  const [selection, setSelection] = useState<string | null>(null)
  const sorted = [...(batches.data ?? [])].sort((a, b) =>
    (b.approval?.at ?? b.createdAt).localeCompare(
      a.approval?.at ?? a.createdAt,
    ),
  )
  const approved = sorted.filter((batch) => batch.state === 'approved')
  const published = sorted.filter((batch) => batch.state === 'published')
  const firstId = approved[0]?.id ?? published[0]?.id
  const selected = selection ?? firstId
  if (batches.error)
    return <p role="alert">Could not load Batches. Please refresh.</p>
  if (batches.isLoading) return <p role="status">Loading Batches…</p>
  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
      <aside className="space-y-4">
        <h1 className="text-2xl font-extrabold">Publish</h1>
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
