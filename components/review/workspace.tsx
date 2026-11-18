'use client'

import { apiErrorReasons } from '@/lib/client/api'
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
import { canEdit, editableStates } from '@/lib/review/access'
import type { EditableFields, ReviewBatch } from '@/lib/review/types'
import { useRecentReviewPlates, useReviewCheckpoint } from '@/lib/client/review-checkpoint'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { cn } from '@/components/utils'
import { changeSummary, DiffTable } from './diff'
import { RunStatus } from './run-status'
import { useBatchRevisionSignal } from '@/lib/client/live-signal'
import { reviewHref } from '@/lib/review/href'
import { localPipelineReason } from '@/lib/local-pipeline'
import { useBatchRun } from '@/lib/client/hooks'

type State = {
  code: string
  name: string
  plateCount?: number
  plates: { id: string; displayName: string; imageUrl: string | null }[]
}
const reviewPageSize = 40

type Entry = BatchDetail['plates'][number] & { batch: ReviewBatch }

export { reviewHref } from '@/lib/review/href'

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
  if (code === 'standard_change_unconfirmed')
    return apiErrorReasons(error).join(' ') || 'Use Standard plate issues to make the first Template the Standard, then submit again.'
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
            <Button variant="outline" disabled title={localPipelineReason('No request-changes transition or comment delivery')}>
              Request changes
            </Button>
            <span className="text-muted-foreground">{localPipelineReason('No request-changes transition or comment delivery')}</span>
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
  const batchId = params.get('batch')
  const selected = useBatch(batchId)
  const me = useMe()
  const actions = useReviewActions()
  const live = useBatchRevisionSignal(batchId, selected.data?.batch.revision ?? -1)
  const filters = { run: params.get('run'), since: params.get('since'), scope: params.get('scope') }
  const since = filters.since !== null && /^\d+$/.test(filters.since) && Number.isSafeInteger(Number(filters.since)) ? Number(filters.since) : null
  const selectedRevision = selected.data?.batch.revision
  const code = params.get('state')
  const plateId = params.get('plate')
  const scope = batchId ? filters.scope ?? (plateId ? null : code) : code
  const recent = useRecentReviewPlates(batchId, since ?? undefined, selectedRevision)
  const reviewedRevision = !filters.run && !scope && (since === null || recent.data) ? selectedRevision : undefined
  useReviewCheckpoint(batchId, reviewedRevision, me.data?.role === 'owner')
  const recentPlates = recent.data ? new Set(recent.data.plateIds) : null
  const [details, setDetails] = useState<Record<string, BatchDetail>>({})
  const [reverting, setReverting] = useState(false)
  const [revertFeedback, setRevertFeedback] = useState<{ plateId: string; message: string; error: boolean } | null>(null)
  const [all, setAll] = useState(false)
  const [search, setSearch] = useState('')
  const [pagination, setPagination] = useState({ scope: '', count: reviewPageSize })
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
      [...(review.data ?? []), ...(mine.data ?? [])].map((batch) => [batch.id, batch]),
    ).values(),
  ]
  if (selected.data && !batches.some((batch) => batch.id === selected.data?.batch.id))
    batches.push(selected.data.batch)
  const currentDetails = {
    ...details,
    ...(selected.data ? { [selected.data.batch.id]: selected.data } : {}),
  }
  const entries: Entry[] = (batchId ? batches.filter(batch => batch.id === batchId) : batches).flatMap(batch => {
    const detail = currentDetails[batch.id]
    return (detail?.plates ?? [])
      .filter(plate => changeSummary(plate.baseline, plate.proposed, plate.order) !== 'No changes')
      .map(plate => ({ ...plate, batch: detail.batch }))
  })
  const pending = entries.filter(({ batch }) => ['submitted', 'conflict'].includes(batch.state))
  const visible = batchId ? entries.filter(entry => {
    const inRun = !filters.run || entry.edit?.pipelineRunIds?.includes(filters.run) ||
      Object.values(entry.edit?.pipelineChanges ?? {}).some(change => change.runId === filters.run)
    return inRun && (since === null || recentPlates?.has(entry.baseline.id) === true)
  }) : pending.length ? pending : entries
  const first = visible[0]
  const state = states.find(state => state.code === code)
  const inState = scope ? visible.filter(entry => entry.baseline.state === scope) : visible
  const term = search.trim().toLowerCase()
  const listed = inState.filter(({ proposed }) => !batchId || !term ||
    [proposed.displayName, proposed.id, proposed.state, ...proposed.tags].some(value => value.toLowerCase().includes(term)))
  const pageScope = JSON.stringify([batchId, filters.run, filters.since, scope, search])
  const pageEnd = pagination.scope === pageScope ? pagination.count : reviewPageSize
  const entry = plateId
    ? visible.find(entry => entry.baseline.id === plateId && (!code || entry.baseline.state === code))
    : listed[0]
  useEffect(() => {
    if (first && !batchId && !params.has('view') && !code)
      router.replace(reviewHref(undefined, undefined, first.batch.id))
  }, [first, batchId, code, params, router])
  const stateCounts = new Map<string, number>()
  for (const { baseline } of batchId ? visible : pending)
    stateCounts.set(baseline.state, (stateCounts.get(baseline.state) ?? 0) + 1)
  const orderedStates = [...states].sort((a, b) => Number(stateCounts.has(b.code)) - Number(stateCounts.has(a.code)))
  const mobile =
    (batchId ? !visible.length || recent.isLoading : !entries.length && !review.isLoading && !mine.isLoading) || plateId
      ? 'detail'
      : batchId || code
        ? 'plates'
        : 'states'
  const images = new Map(states.flatMap(state => state.plates.map(plate => [plate.id, plate.imageUrl])))
  const plateImage = (id: string) => images.get(id)
  async function revert(field: keyof EditableFields, jobId: string) {
    if (!entry) return
    const plateId = entry.baseline.id
    setReverting(true)
    setRevertFeedback(null)
    try {
      await actions.revertPipelineField(entry.batch.id, plateId, field, jobId)
      setRevertFeedback({ plateId, message: 'Pipeline field reverted.', error: false })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      setRevertFeedback({ plateId, message: code === 'superseded_revision' || code === 'stale_plate'
        ? 'This field changed while you were reviewing. Check its latest value.'
        : reviewError(error, entry.batch.revision), error: true })
    } finally {
      setReverting(false)
    }
  }
  return (
    <div className="grid min-h-[calc(100dvh-var(--header-h)-var(--space-6)*2)] min-w-0 grid-cols-1 gap-4 md:h-[calc(100dvh-var(--header-h)-var(--space-6)*2)] md:grid-cols-[200px_290px_minmax(0,1fr)]">
      {(!batchId ? batches : []).map((batch) => (
        <BatchLoader key={batch.id} batch={batch} onLoad={loaded} />
      ))}
      <aside
        className={cn(
          'overflow-y-auto rounded-3xl bg-card p-3 md:block',
          mobile !== 'states' && 'hidden',
        )}
      >
        <h1 className="p-2 text-xs font-extrabold">
          {batchId ? selected.data?.batch.name ?? 'Batch' : 'States with changes first'}
        </h1>
        {batchId && (
          <>
            <Link className="block px-2 pb-2 text-xs underline" href="/review?view=states">All batches</Link>
            <p className="px-2 pb-2 text-xs text-muted-foreground" role="status">{live}</p>
            {live === 'Live updates unavailable' && <Button size="sm" variant="outline" onClick={() => void selected.mutate()}>Refresh Batch</Button>}
            <Link className={cn('block rounded-xl p-2 text-sm', !scope && 'bg-primary text-primary-foreground')} href={reviewHref(undefined, undefined, batchId, { ...filters, scope: null })}>
              All states <span className="ml-1">{visible.length}</span>
            </Link>
          </>
        )}
        {!batchId && batches.length > 0 && (
          <nav aria-label="Batches" className="mb-2 border-b border-[var(--hairline)] pb-2">
            {batches.map(batch => <Link className="block rounded-xl p-2 text-sm underline" href={reviewHref(undefined, undefined, batch.id)} key={batch.id}>{batch.name}</Link>)}
          </nav>
        )}
        {orderedStates.filter(item => !batchId || stateCounts.has(item.code)).map(item => {
          const count = stateCounts.get(item.code)
          return (
            <Link
              key={item.code}
              href={reviewHref(item.code, undefined, batchId ?? undefined, { ...filters, scope: null })}
              className={cn(
                'flex min-h-10 items-center gap-3 rounded-xl px-2 text-sm',
                scope === item.code && 'bg-primary text-primary-foreground',
              )}
            >
              <strong>{item.code}</strong>
              <span className="flex-1">{item.name}</span>
              {count !== undefined && (
                <span className="rounded-full bg-[var(--info-tint)] px-2 text-[var(--ink)]">{count}</span>
              )}
              <IoChevronForward aria-hidden="true" />
            </Link>
          )
        })}
      </aside>
      <section
        aria-label="Plates"
        className={cn(
          'min-h-0 min-w-0 flex-col rounded-3xl bg-card p-3 md:flex',
          mobile === 'plates' ? 'flex' : 'hidden',
        )}
      >
        <Link
          href="/review?view=states"
          className="mb-3 flex items-center text-xs md:hidden"
        >
          <IoChevronBack />
          {batchId ? 'Batches' : 'States'}
        </Link>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-extrabold">{batchId ? selected.data?.batch.name ?? 'Batch' : state?.name ?? 'Plates'}</h2>
          {batchId ? <span className="text-xs">{visible.length} changed {visible.length === 1 ? 'Plate' : 'Plates'}</span> : (
          <div className="flex rounded-full bg-muted p-1 text-xs">
            <button
              className={cn(
                'rounded-full px-3 py-1',
                !all && 'bg-primary text-primary-foreground',
              )}
              onClick={() => setAll(false)}
            >
              Changed {listed.length}
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
          </div>)}
        </div>
        {batchId && (
          <div className="grid gap-2 pb-3 text-sm">
            {(filters.run || since !== null) && visible.length > 0 && (
              <div className="flex flex-wrap justify-between gap-2 text-xs">
                <span>{filters.run ? 'Run changes' : 'New changes'}</span>
                <Link className="underline" href={reviewHref(undefined, undefined, batchId)}>Show all Batch changes</Link>
              </div>
            )}
            <label className="md:hidden">
              <span className="sr-only">Filter by state</span>
              <select className="w-full rounded-xl border border-[var(--hairline)] bg-card p-2" value={scope ?? ''} onChange={event => router.push(reviewHref(event.target.value, undefined, batchId, { ...filters, scope: null }))}>
                <option value="">All states</option>
                {orderedStates.filter(item => stateCounts.has(item.code)).map(item => <option key={item.code} value={item.code}>{item.name}</option>)}
              </select>
            </label>
            <input className="rounded-xl border border-[var(--hairline)] bg-card p-2" type="search" aria-label="Search changed plates" placeholder="Search plates" value={search} onChange={event => setSearch(event.target.value)} />
          </div>
        )}
        <div className="max-h-[75dvh] min-h-0 flex-1 overflow-y-auto md:max-h-full">
          {((!batchId && all)
            ? (state?.plates ?? [])
            : listed.slice(0, pageEnd).map((entry) => ({
                id: entry.baseline.id,
                displayName: entry.proposed.displayName,
                imageUrl: entry.afterImageUrl ?? plateImage(entry.baseline.id),
                entry,
              }))
          ).map((plate, index) => {
            const item =
              'entry' in plate
                ? (plate.entry as Entry)
                : inState.find((entry) => entry.baseline.id === plate.id)
            return (
              <Link
                key={`${plate.id}-${item?.batch.id ?? index}`}
                aria-label={`${plate.displayName} · ${item?.baseline.state ?? code ?? ''}`}
                aria-current={entry?.baseline.id === plate.id && entry.batch.id === item?.batch.id ? 'true' : undefined}
                prefetch={false}
                href={reviewHref(item?.baseline.state ?? code ?? undefined, plate.id, item?.batch.id, { ...filters, scope: batchId ? scope : null })}
                className={cn(
                  'flex min-h-14 items-center gap-3 rounded-2xl p-2',
                  entry?.baseline.id === plate.id && entry.batch.id === item?.batch.id && 'bg-muted',
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
                  <strong className="block text-sm">{plate.displayName}{batchId && item && <span className="ml-1 font-normal text-muted-foreground">{item.baseline.state}</span>}</strong>
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
          {batchId && pageEnd < listed.length && <Button variant="outline" size="sm" className="mx-2 my-3" onClick={() => setPagination({ scope: pageScope, count: pageEnd + reviewPageSize })}>Load more plates</Button>}
          {batchId && term && !listed.length && <p className="p-2 text-sm">No plates match your search.</p>}
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
          href={reviewHref(scope ?? undefined, undefined, batchId ?? undefined, { ...filters, scope: null })}
          className="flex items-center text-xs md:hidden"
        >
          <IoChevronBack />
          Plates
        </Link>
        {revertFeedback && (revertFeedback.plateId === entry?.baseline.id || revertFeedback.plateId === plateId) && (
          <p role={revertFeedback.error ? 'alert' : 'status'}>{revertFeedback.message}</p>
        )}
        {recent.error ? (
          <div role="alert">
            <p>Could not load new changes.</p>
            <Button variant="outline" size="sm" onClick={() => void recent.mutate()}>Retry</Button>
          </div>
        ) : recent.isLoading ? <p role="status">Loading new changes…</p> : entry ? (
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
              beforeImageUrl={entry.beforeImageUrl ?? plateImage(entry.baseline.id)}
              afterImageUrl={entry.afterImageUrl}
              after={entry.proposed}
              version={entry.batch.baselineVersion}
              revision={entry.batch.revision}
              positions={entry.order}
              order={state?.code === entry.baseline.state ? state.plates.map(plate => plate.id) : []}
              pipelineChanges={entry.edit?.pipelineChanges}
              reverting={reverting}
              onRevert={me.data && canEdit(entry.batch, me.data) && editableStates.includes(entry.batch.state) ? revert : undefined}
            />
            <RunStatus batchId={entry.batch.id} />
            <ReviewFooter
              key={entry.batch.id}
              detail={currentDetails[entry.batch.id]}
            />
          </>
        ) : review.error || mine.error || selected.error ? (
          <p role="alert">Could not load review batches. Please refresh.</p>
        ) : (batchId ? selected.isLoading : review.isLoading || mine.isLoading || batches.some(batch => !currentDetails[batch.id])) ? (
          <p role="status">Loading review batches…</p>
        ) : (
          <div className="m-auto text-center">
            <h2 className="text-lg font-extrabold">
              {filters.run ? 'This run has no saved draft changes'
                : since !== null ? 'No new changes in this Batch'
                  : plateId ? 'No changes for this plate'
                    : batchId ? 'No draft changes in this Batch'
                      : 'Nothing waiting for review'}
            </h2>
            <Link href={batchId && (filters.run || since !== null) ? reviewHref(undefined, undefined, batchId) : '/'} className="underline">
              {batchId && (filters.run || since !== null) ? 'Show all Batch changes' : 'Dashboard'}
            </Link>
          </div>
        )}
      </section>
    </div>
  )
}
