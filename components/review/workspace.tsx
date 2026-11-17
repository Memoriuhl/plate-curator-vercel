'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  IoChevronBack,
  IoChevronForward,
  IoCheckmark,
  IoPersonOutline,
} from 'react-icons/io5'
import {
  useBatch,
  useBatches,
  useMe,
  useReviewActions,
} from '@/lib/client/hooks'
import type { BatchDetail } from '@/lib/client/hooks'
import type { ReviewBatch } from '@/lib/review/types'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { cn } from '@/components/utils'
import { changeSummary, DiffTable } from './diff'
import { RunStatus } from './run-status'
import { useBatchRun } from '@/lib/client/hooks'

type State = {
  code: string
  name: string
  plateCount?: number
  plates: { id: string; displayName: string; imageUrl: string | null }[]
}
type Entry = BatchDetail['plates'][number] & { batch: ReviewBatch }

export function reviewHref(state: string, plate?: string, batch?: string) {
  const query = new URLSearchParams({ state })
  if (plate) query.set('plate', plate)
  if (batch) query.set('batch', batch)
  return `/review?${query}`
}

function Author({ uid, name }: { uid: string; name?: string | null }) {
  const me = useMe()
  const own = me.data?.uid === uid
  const initial = name?.trim().slice(0, 1).toUpperCase()
  return (
    <Avatar
      size="sm"
      player={own ? 'you' : 'friend'}
      aria-label={name || 'Curator'}
    >
      <AvatarFallback>
        {initial || <IoPersonOutline aria-hidden="true" />}
      </AvatarFallback>
    </Avatar>
  )
}

function BatchLoader({
  batch,
  onLoad,
}: {
  batch: ReviewBatch
  onLoad: (id: string, detail: BatchDetail) => void
}) {
  const { data, error } = useBatch(batch.id)
  useEffect(() => {
    if (data) onLoad(batch.id, data)
  }, [data, batch.id, onLoad])
  return error ? <p role="alert">Could not load batch {batch.name}.</p> : null
}

function when(at: string) {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString()
}

export function reviewError(error: unknown, revision: number) {
  const code =
    error && typeof error === 'object' && 'code' in error ? error.code : ''
  if (code === 'superseded_revision')
    return `This batch changed while you were reviewing. Look again at revision ${revision}.`
  if (code === 'invalid_state')
    return 'This batch is no longer available for this action. Refresh and look again.'
  return 'Could not save this action. Please try again.'
}

export function ReviewFooter({ detail }: { detail: BatchDetail }) {
  const me = useMe()
  const actions = useReviewActions()
  const latest = useBatch(detail.batch.id)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const batch = detail.batch
  const run = useBatchRun(batch.state === 'published' ? batch.id : null)
  const approvedBy =
    batch.approval?.by === me.data?.uid
      ? me.data?.name
      : batch.approval?.by === batch.createdBy
        ? batch.createdByName
        : null
  const counts = new Map<string, number>()
  for (const plate of detail.plates)
    counts.set(
      plate.baseline.state,
      (counts.get(plate.baseline.state) ?? 0) + 1,
    )
  const scope = [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => `${code} ${count}`)
    .join(', ')
  const submit = batch.state === 'open' && batch.createdBy === me.data?.uid
  const approve =
    me.data?.role === 'owner' && ['submitted', 'conflict'].includes(batch.state)
  async function act() {
    setBusy(true)
    setMessage('')
    try {
      await (submit ? actions.submit : actions.approve)(
        batch.id,
        batch.revision,
      )
    } catch (error) {
      const current = await latest.mutate().catch(() => undefined)
      setMessage(reviewError(error, current?.batch.revision ?? batch.revision))
    } finally {
      setBusy(false)
    }
  }
  return (
    <footer className="mt-auto flex flex-wrap items-center gap-3 border-t border-[var(--hairline)] pt-4 text-xs">
      {batch.source && <p className="w-full">Copied from <Link className="underline" href={`/review?batch=${encodeURIComponent(batch.source.batchId)}`}>original Batch revision {batch.source.revision}</Link>. Review against Catalog v{batch.baselineVersion}.</p>}
      {batch.state === 'published' ? <p className="font-bold">Published · v{run.data?.outcome?.version ?? '?'}</p> : batch.state === 'approved' ? (
        <p>
          Approved by {approvedBy || 'an Owner'}
          {batch.approval?.at ? ` on ${when(batch.approval.at)}` : ''}
        </p>
      ) : (
        <>
          <p className="min-w-0 flex-1">
            Approving &quot;{batch.name}&quot; by{' '}
            {batch.createdByName || 'a curator'} covers all{' '}
            {detail.plates.length} changes in revision {batch.revision} ({scope}
            ). Any later edit asks you to look again.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled title="Coming soon">
              Request changes
            </Button>
            <span className="text-muted-foreground">Coming soon</span>
            {approve || submit ? (
              <Button disabled={busy} onClick={act}>
                {approve && <IoCheckmark aria-hidden="true" />}
                {submit
                  ? 'Submit for review'
                  : `Approve revision ${batch.revision}`}
              </Button>
            ) : (
              <p>Waiting for an Owner to approve</p>
            )}
          </div>
        </>
      )}
      {message && (
        <p className="w-full" role="alert">
          {message}
        </p>
      )}
    </footer>
  )
}

export function ReviewWorkspace({ states }: { states: State[] }) {
  const params = useSearchParams()
  const router = useRouter()
  const review = useBatches(['submitted', 'conflict'])
  const mine = useBatches(['open'], { mine: true })
  const selected = useBatch(params.get('batch'))
  const [details, setDetails] = useState<Record<string, BatchDetail>>({})
  const [all, setAll] = useState(false)
  const [now] = useState(() => Date.now())
  const loaded = useCallback(
    (id: string, detail: BatchDetail) =>
      setDetails((previous) =>
        previous[id] === detail ? previous : { ...previous, [id]: detail },
      ),
    [],
  )
  const batches = [
    ...new Map(
      [...(review.data ?? []), ...(mine.data ?? [])].map((batch) => [
        batch.id,
        batch,
      ]),
    ).values(),
  ]
  if (
    selected.data &&
    !batches.some((batch) => batch.id === selected.data!.batch.id)
  )
    batches.push(selected.data.batch)
  const currentDetails = {
    ...details,
    ...(selected.data ? { [selected.data.batch.id]: selected.data } : {}),
  }
  const entries: Entry[] = batches.flatMap((batch) =>
    (currentDetails[batch.id]?.plates ?? []).map((plate) => ({
      ...plate,
      batch: currentDetails[batch.id].batch,
    })),
  )
  const pending = entries.filter((entry) =>
    ['submitted', 'conflict'].includes(entry.batch.state),
  )
  const visible = pending.length
    ? entries.filter(
        (entry) =>
          ['submitted', 'conflict'].includes(entry.batch.state) ||
          entry.batch.id === params.get('batch'),
      )
    : entries
  const first =
    entries.find((entry) => entry.batch.id === params.get('batch')) ??
    pending[0] ??
    entries[0]
  const code = params.get('state') ?? first?.baseline.state
  const state = states.find((state) => state.code === code)
  const inState = visible.filter((entry) => entry.baseline.state === code)
  const entry =
    inState.find(
      (entry) =>
        entry.baseline.id === params.get('plate') &&
        (!params.get('batch') || entry.batch.id === params.get('batch')),
    ) ?? (!params.get('plate') ? inState.find(entry => !params.get('batch') || entry.batch.id === params.get('batch')) : undefined)
  useEffect(() => {
    if (first && (!params.get('batch') || first.batch.id === params.get('batch')) && !params.has('view') && !params.get('state'))
      router.replace(
        reviewHref(first.baseline.state, first.baseline.id, first.batch.id),
      )
  }, [first, params, router])
  const changedStates = states.filter((state) =>
    pending.some((entry) => entry.baseline.state === state.code),
  )
  const orderedStates = [
    ...changedStates,
    ...states.filter((state) => !changedStates.includes(state)),
  ]
  const mobile =
    !entries.length && !review.isLoading && !mine.isLoading
      ? 'detail'
      : params.get('plate')
        ? 'detail'
        : params.get('state')
          ? 'plates'
          : 'states'
  const plateImage = (id: string) =>
    states.flatMap((state) => state.plates).find((plate) => plate.id === id)
      ?.imageUrl
  return (
    <div className="grid min-h-[calc(100dvh-var(--header-h)-var(--space-6)*2)] min-w-0 grid-cols-1 gap-4 md:h-[calc(100dvh-var(--header-h)-var(--space-6)*2)] md:grid-cols-[200px_290px_minmax(0,1fr)]">
      {batches.map((batch) => (
        <BatchLoader key={batch.id} batch={batch} onLoad={loaded} />
      ))}
      <aside
        className={cn(
          'overflow-y-auto rounded-3xl bg-card p-3 md:block',
          mobile !== 'states' && 'hidden',
        )}
      >
        <h1 className="p-2 text-xs font-extrabold">
          States with changes first
        </h1>
        {orderedStates.map((item) => {
          const changes = pending.filter(
            (entry) => entry.baseline.state === item.code,
          )
          return (
            <Link
              key={item.code}
              href={reviewHref(item.code)}
              className={cn(
                'flex min-h-10 items-center gap-3 rounded-xl px-2 text-sm',
                code === item.code && 'bg-primary text-primary-foreground',
              )}
            >
              <strong>{item.code}</strong>
              <span className="flex-1">{item.name}</span>
              {changes.length > 0 && (
                <span className="rounded-full bg-[var(--info-tint)] px-2 text-[var(--ink)]">
                  {changes.length}
                </span>
              )}
              <IoChevronForward aria-hidden="true" />
            </Link>
          )
        })}
      </aside>
      <section
        aria-label="Plates"
        className={cn(
          'min-w-0 rounded-3xl bg-card p-3 md:block',
          mobile !== 'plates' && 'hidden',
        )}
      >
        <Link
          href="/review?view=states"
          className="mb-3 flex items-center text-xs md:hidden"
        >
          <IoChevronBack />
          States
        </Link>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-extrabold">{state?.name ?? 'Plates'}</h2>
          <div className="flex rounded-full bg-muted p-1 text-xs">
            <button
              className={cn(
                'rounded-full px-3 py-1',
                !all && 'bg-primary text-primary-foreground',
              )}
              onClick={() => setAll(false)}
            >
              Changed {inState.length}
            </button>
            <button
              className={cn(
                'rounded-full px-3 py-1',
                all && 'bg-primary text-primary-foreground',
              )}
              onClick={() => setAll(true)}
            >
              All {state?.plateCount ?? state?.plates.length ?? 0}
            </button>
          </div>
        </div>
        <div className="max-h-[75dvh] overflow-y-auto">
          {(all
            ? (state?.plates ?? [])
            : inState.map((entry) => ({
                id: entry.baseline.id,
                displayName: entry.proposed.displayName,
                imageUrl: plateImage(entry.baseline.id),
                entry,
              }))
          ).map((plate, index) => {
            const item =
              'entry' in plate
                ? (plate.entry as Entry)
                : inState.find((entry) => entry.baseline.id === plate.id)
            return (
              <Link
                key={`${plate.id}-${index}`}
                href={reviewHref(code!, plate.id, item?.batch.id)}
                className={cn(
                  'flex min-h-14 items-center gap-3 rounded-2xl p-2',
                  params.get('plate') === plate.id &&
                    (!params.get('batch') ||
                      params.get('batch') === item?.batch.id) &&
                    'bg-muted',
                )}
              >
                {plate.imageUrl ? (
                  <Image
                    unoptimized
                    src={plate.imageUrl}
                    alt=""
                    width={72}
                    height={36}
                    className="h-9 w-[72px] object-contain"
                  />
                ) : (
                  <span className="h-9 w-[72px] shrink-0 rounded bg-muted" />
                )}
                <span className="min-w-0 flex-1">
                  <strong className="block text-sm">{plate.displayName}</strong>
                  <span className="block truncate text-xs text-muted-foreground">
                    {item
                      ? changeSummary(item.baseline, item.proposed, item.order)
                      : 'No changes'}
                  </span>
                  {item && (
                    <span
                      className="mt-1 inline-block max-w-full truncate rounded-full bg-muted px-2 py-0.5 text-[10px]"
                      title={`${item.batch.name} by ${item.batch.createdByName || 'a curator'}`}
                    >
                      {item.batch.name} · by{' '}
                      {item.batch.createdByName || 'a curator'}
                    </span>
                  )}
                </span>
                {item && (
                  <Author
                    uid={item.batch.createdBy}
                    name={item.batch.createdByName}
                  />
                )}
              </Link>
            )
          })}
        </div>
      </section>
      <section
        aria-label="Before and after"
        className={cn(
          'flex min-w-0 flex-col gap-4 rounded-3xl bg-card p-4 [overflow-wrap:anywhere] md:overflow-y-auto',
          mobile !== 'detail' && 'hidden md:flex',
        )}
      >
        <Link
          href={reviewHref(code ?? '')}
          className="flex items-center text-xs md:hidden"
        >
          <IoChevronBack />
          Plates
        </Link>
        {entry ? (
          <>
            <header className="flex flex-wrap items-center gap-3">
              {plateImage(entry.baseline.id) && (
                <Image
                  unoptimized
                  src={plateImage(entry.baseline.id)!}
                  alt={entry.proposed.displayName}
                  width={96}
                  height={48}
                  className="h-12 w-24 object-contain"
                />
              )}
              <div className="min-w-0 flex-1">
                <h2 className="text-xl font-extrabold">
                  {entry.proposed.displayName}
                </h2>
                <p className="font-mono text-xs text-muted-foreground">
                  {entry.baseline.id}
                </p>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
                <span>Revisions</span>
                {Array.from(
                  {
                    length: Math.min(20, Math.max(0, entry.batch.revision - 1)),
                  },
                  (_, i) => (
                    <span key={i} className="size-2 rounded-full bg-muted" />
                  ),
                )}
                <span className="flex items-center gap-2 rounded-full bg-primary p-1 pr-3 text-primary-foreground">
                  <Author
                    uid={entry.batch.createdBy}
                    name={entry.batch.createdByName}
                  />
                  rev {entry.batch.revision} ·{' '}
                  {entry.edit
                    ? `${Math.max(0, Math.floor((now - Date.parse(entry.edit.updatedAt)) / 60000))} min ago`
                    : 'no edits'}
                </span>
              </div>
            </header>
            <DiffTable
              before={entry.baseline}
              beforeImageUrl={plateImage(entry.baseline.id)}
              after={entry.proposed}
              version={entry.batch.baselineVersion}
              revision={entry.batch.revision}
              positions={entry.order}
              order={state?.plates.map((plate) => plate.id) ?? []}
            />
            <RunStatus batchId={entry.batch.id} />
            <ReviewFooter
              key={entry.batch.id}
              detail={currentDetails[entry.batch.id]}
            />
          </>
        ) : review.error || mine.error || selected.error ? (
          <p role="alert">Could not load review batches. Please refresh.</p>
        ) : review.isLoading ||
          mine.isLoading ||
          batches.some((batch) => !currentDetails[batch.id]) ? (
          <p role="status">Loading review batches…</p>
        ) : (
          <div className="m-auto text-center">
            <h2 className="text-lg font-extrabold">
              {params.get('plate')
                ? 'No changes for this plate'
                : 'Nothing waiting for review'}
            </h2>
            <Link href="/" className="underline">
              Dashboard
            </Link>
          </div>
        )}
      </section>
    </div>
  )
}
