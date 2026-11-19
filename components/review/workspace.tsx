'use client'

import { apiErrorReasons } from '@/lib/client/api'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import {
  PlateImageHover,
  PlateEnhancementPreview,
} from '@/components/plate/plate-image-preview'
import { PlateHoverPreview } from '@/components/plate/plate-hover-preview'
import { HoverCard } from 'radix-ui'
import { PlateChangeIcons } from './plate-change-icons'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  IoChevronBack,
  IoChevronForward,
  IoFunnelOutline,
  IoPersonOutline,
} from 'react-icons/io5'
import {
  useBatch,
  useBatches,
  useMe,
  useReviewActions,
  useSharedDraftId,
} from '@/lib/client/hooks'
import type { BatchDetail } from '@/lib/client/hooks'
import { canEdit, editableStates } from '@/lib/review/access'
import {
  isRelease,
  isSharedDraft,
  isSharedDraftId,
} from '@/lib/review/draft/draft-id'
import type { DraftChangeTarget, ReviewBatch } from '@/lib/review/types'
import {
  useRecentReviewPlates,
  useReviewCheckpoint,
} from '@/lib/client/review-checkpoint'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { cn } from '@/components/utils'
import { changeSummary, DiffTable } from './diff'
import { RunStatus } from './run-status'
import { useBatchRevisionSignal } from '@/lib/client/live-signal'
import { hasPipelineHistory } from '@/lib/review/pipeline-changes'
import { batchHref, reviewHref } from '@/lib/review/href'
import { BatchLastChanged } from './batch-last-changed'
import { ReviewRunRevertButton } from './run-revert-button'
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

type StateVisibility = 'all' | 'changed'

function StateVisibilityControl({
  value,
  onChange,
}: {
  value: StateVisibility
  onChange: (value: StateVisibility) => void
}) {
  const name = useId()
  return (
    <fieldset className="grid grid-cols-2 gap-1 rounded-full bg-muted p-1">
      <legend className="sr-only">States to show</legend>
      {(['all', 'changed'] as const).map((option) => (
        <label key={option} className="min-w-0 cursor-pointer">
          <input
            className="peer sr-only"
            type="radio"
            name={name}
            checked={value === option}
            onChange={() => onChange(option)}
          />
          <span className="flex min-h-8 items-center justify-center gap-1 whitespace-nowrap rounded-full px-1 text-xs font-bold text-muted-foreground transition-colors peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary motion-reduce:transition-none">
            {option === 'all' ? (
              'All states'
            ) : (
              <>
                <IoFunnelOutline
                  aria-hidden="true"
                  className="size-3 shrink-0"
                />
                Changed
              </>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  )
}

/**
 * Render the batch author's avatar, using the signed-in profile when it belongs to the
 * viewer.
 */
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

/**
 * Name whoever last saved this change. Everyone edits the same shared draft, so the
 * draft's creator is only a fallback for an edit saved before names were recorded.
 */
function changeAuthor(item: {
  batch: { createdBy: string; createdByName: string | null }
  edit?: { authorId: string; authorName?: string | null } | null
}) {
  const uid = item.edit?.authorId ?? item.batch.createdBy
  return {
    uid,
    name:
      item.edit?.authorName ??
      (uid === item.batch.createdBy ? item.batch.createdByName : null),
  }
}

/**
 * Load one batch detail and communicate its current data or failure to the review
 * workspace.
 */
function BatchLoader({
  batch,
  onLoad,
}: {
  batch: ReviewBatch
  onLoad: (id: string, detail: BatchDetail | null) => void
}) {
  const { data, error, mutate } = useBatch(batch.id)
  const requested = useRef(-1)
  useEffect(() => {
    if (data || error) onLoad(batch.id, data ?? null)
  }, [data, error, batch.id, onLoad])
  useEffect(() => {
    if (
      data &&
      data.batch.revision < batch.revision &&
      requested.current !== batch.revision
    ) {
      requested.current = batch.revision
      void mutate().catch(() => undefined)
    }
  }, [batch.revision, data, mutate])
  return error ? <p role="alert">Could not load batch {batch.name}.</p> : null
}

/**
 * Format an audit timestamp for display while retaining an unreadable value for
 * inspection.
 */
function when(at: string) {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString()
}

/**
 * Turn review action failures into readable messages and preserve server validation
 * reasons.
 */
export function reviewError(error: unknown, revision: number) {
  const code =
    error && typeof error === 'object' && 'code' in error ? error.code : ''
  if (code === 'superseded_revision')
    return `This plate changed while you were reviewing. Look again at revision ${revision}.`
  if (code === 'standard_change_unconfirmed')
    return (
      apiErrorReasons(error).join(' ') ||
      'Use Standard plate issues to make the first Template the Standard, then try again.'
    )
  if (code === 'pipeline_busy')
    return 'Try again after the Plate Pipeline finishes its runs.'
  if (code === 'invalid_state')
    return 'This change is no longer available for this action. Refresh and look again.'
  return 'Could not save this action. Please try again.'
}

/**
 * Show what the displayed draft, release or history Batch changes. Review has no Submit
 * or Approve step: every curator's edits sit in the shared draft until the Owner
 * publishes it.
 */
export function ReviewFooter({ detail }: { detail: BatchDetail }) {
  const me = useMe()
  const batch = detail.batch
  const run = useBatchRun(batch.state === 'published' ? batch.id : null)
  const approvedBy =
    batch.approval?.by === me.data?.uid
      ? me.data?.name
      : batch.approval?.by === batch.createdBy
        ? batch.createdByName
        : null
  const changed = detail.plates.filter(
    (plate) =>
      changeSummary(plate.baseline, plate.proposed, plate.order) !==
      'No changes'
  )
  const affectedStates = [
    ...new Set(changed.map((plate) => plate.baseline.state)),
  ].sort()
  return (
    <footer className="mt-auto flex flex-wrap items-center gap-3 border-t border-[var(--hairline)] pt-4 text-xs">
      {batch.source &&
        (isRelease(batch) ? (
          <p className="w-full">
            Release of the shared draft at revision {batch.source.revision},
            against Catalog v{batch.baselineVersion}.
          </p>
        ) : (
          <p className="w-full">
            Copied from{' '}
            <Link
              className="underline"
              href={reviewHref(undefined, undefined, batch.source.batchId)}
            >
              original Batch revision {batch.source.revision}
            </Link>
            . Review against Catalog v{batch.baselineVersion}.
          </p>
        ))}
      {batch.state === 'published' ? (
        <p className="font-bold">
          Published · v{run.data?.outcome?.version ?? '?'}
        </p>
      ) : batch.state === 'folded' ? (
        <p>Folded into the shared draft</p>
      ) : batch.state === 'approved' && !isRelease(batch) ? (
        <p>
          Approved by {approvedBy || 'an Owner'}
          {batch.approval?.at ? ` on ${when(batch.approval.at)}` : ''}
        </p>
      ) : (
        <p className="min-w-0 flex-1" title={affectedStates.join(', ')}>
          {changed.length} changed {changed.length === 1 ? 'plate' : 'plates'} ·
          rev {batch.revision}
        </p>
      )}
      {isSharedDraft(batch) && (
        <p className="w-full text-muted-foreground">
          Shared draft · unpublished changes from every curator.
          {me.data?.role === 'owner' && (
            <>
              {' '}
              <Link className="underline" href="/publish">
                Publish the draft
              </Link>
            </>
          )}
        </p>
      )}
    </footer>
  )
}

/**
 * Resolve the active review batch and plate from the URL and render the live diff
 * workspace.
 */
export function ReviewWorkspace({ states }: { states: State[] }) {
  const params = useSearchParams()
  const router = useRouter()
  const batchId = params.get('batch')
  // Without a linked Batch, Review lists every unpublished change: the shared draft.
  // Polling the open list is cheap; each loader refetches detail only on a new revision.
  const draftId = useSharedDraftId()
  const open = useBatches(['open'], {
    enabled: !batchId,
    refreshInterval: 5000,
  })
  const selected = useBatch(batchId)
  const me = useMe()
  const actions = useReviewActions()
  const live = useBatchRevisionSignal(
    batchId,
    selected.data?.batch.revision ?? -1
  )
  const filters = {
    run: params.get('run'),
    since: params.get('since'),
    scope: params.get('scope'),
  }
  const since =
    filters.since !== null &&
    /^\d+$/.test(filters.since) &&
    Number.isSafeInteger(Number(filters.since))
      ? Number(filters.since)
      : null
  const selectedRevision = selected.data?.batch.revision
  const code = params.get('state')
  const plateId = params.get('plate')
  const focusBatch = params.get('focusBatch')
  const scope = batchId ? (filters.scope ?? (plateId ? null : code)) : code
  const recent = useRecentReviewPlates(
    batchId,
    since ?? undefined,
    selectedRevision
  )
  const reviewedRevision =
    !filters.run && !scope && since === null ? selectedRevision : undefined
  useReviewCheckpoint(batchId, reviewedRevision, me.data?.role === 'owner')
  const recentPlates = recent.data ? new Set(recent.data.plateIds) : null
  // Retain loaded details by batch ID so review rows can reuse them as the list changes.
  const [details, setDetails] = useState<Record<string, BatchDetail | null>>({})
  const [reverting, setReverting] = useState(false)
  const [revertFeedback, setRevertFeedback] = useState<{
    plateId: string
    message: string
    error: boolean
  } | null>(null)
  const [search, setSearch] = useState('')
  const [stateVisibility, setStateVisibility] =
    useState<StateVisibility>('changed')
  const [pagination, setPagination] = useState({
    scope: '',
    count: reviewPageSize,
  })
  // Keep the loader callback stable so review rerenders don't retrigger its effect.
  const loaded = useCallback(
    (id: string, detail: BatchDetail | null) =>
      setDetails((previous) =>
        previous[id] === detail ? previous : { ...previous, [id]: detail }
      ),
    []
  )
  const batches = [
    ...new Map(
      (open.data ?? [])
        .filter((batch) => batch.id === draftId)
        .map((batch) => [batch.id, batch])
    ).values(),
  ]
  if (
    selected.data &&
    !batches.some((batch) => batch.id === selected.data?.batch.id)
  )
    batches.push(selected.data.batch)
  const currentDetails = {
    ...details,
    ...(selected.data ? { [selected.data.batch.id]: selected.data } : {}),
  }
  const batchEntries: Entry[] = (
    batchId ? batches.filter((batch) => batch.id === batchId) : batches
  ).flatMap((batch) => {
    const detail = currentDetails[batch.id]
    return detail
      ? detail.plates.map((plate) => ({ ...plate, batch: detail.batch }))
      : []
  })
  const entries = batchEntries.filter(
    (plate) =>
      changeSummary(plate.baseline, plate.proposed, plate.order) !==
      'No changes'
  )
  const visible = batchId
    ? (filters.run ? batchEntries : entries).filter((entry) => {
        const inRun =
          !filters.run ||
          entry.edit?.pipelineRunIds?.includes(filters.run) ||
          Object.values(entry.edit?.pipelineChanges ?? {}).some(
            (change) => change.runId === filters.run
          )
        return (
          inRun &&
          (since === null || recentPlates?.has(entry.baseline.id) === true)
        )
      })
    : entries
  const state = states.find((state) => state.code === code)
  const byPlate = Map.groupBy(visible, (entry) => entry.baseline.id)
  const changedAt = (entry: Entry) =>
    entry.edit?.updatedAt ?? entry.batch.lastChangedAt ?? entry.batch.createdAt
  for (const group of byPlate.values())
    group.sort((a, b) => changedAt(b).localeCompare(changedAt(a)))
  const inState = [...byPlate.values()].filter(
    ([item]) => !scope || item.baseline.state === scope
  )
  const term = search.trim().toLowerCase()
  const listed = inState.filter(
    (group) =>
      !term ||
      group.some(({ proposed, batch }) =>
        [
          proposed.displayName,
          proposed.id,
          proposed.state,
          batch.name,
          ...proposed.tags,
        ].some((value) => value.toLowerCase().includes(term))
      )
  )
  const pageScope = JSON.stringify([
    batchId,
    filters.run,
    filters.since,
    scope,
    code,
    search,
  ])
  const pageEnd =
    pagination.scope === pageScope ? pagination.count : reviewPageSize
  const candidateEntries =
    batchId && !filters.run && since === null
      ? batchEntries.filter(
          (entry) => entry.edit && hasPipelineHistory(entry.edit)
        )
      : []
  const selectedEntries = plateId
    ? (
        byPlate.get(plateId) ??
        candidateEntries.filter((entry) => entry.baseline.id === plateId)
      ).filter((entry) => !code || entry.baseline.state === code)
    : (listed[0] ?? [])
  const entry =
    (!batchId && focusBatch
      ? selectedEntries.find((item) => item.batch.id === focusBatch)
      : undefined) ?? selectedEntries[0]
  const comparisons = entry
    ? [entry, ...selectedEntries.filter((item) => item !== entry)]
    : []
  const stateCounts = new Map<string, number>()
  for (const [{ baseline }] of byPlate.values())
    stateCounts.set(baseline.state, (stateCounts.get(baseline.state) ?? 0) + 1)
  const orderedStates = [...states].sort(
    (a, b) => Number(stateCounts.has(b.code)) - Number(stateCounts.has(a.code))
  )
  const shownStates =
    stateVisibility === 'changed'
      ? orderedStates.filter((item) => stateCounts.has(item.code))
      : orderedStates
  const loading = batchId
    ? selected.isLoading
    : open.isLoading ||
      !draftId ||
      batches.some((batch) => !(batch.id in currentDetails))
  const mobile =
    !batchId && params.get('view') === 'states' && !code && !plateId
      ? 'states'
      : plateId ||
          (!filters.run && !listed.length && !term) ||
          (batchId && recent.isLoading)
        ? 'detail'
        : 'plates'
  const images = new Map(
    states.flatMap((state) =>
      state.plates.map((plate) => [plate.id, plate.imageUrl])
    )
  )
  /**
   * Retrieve the image for a related plate from the review workspace's preloaded index.
   */
  const plateImage = (id: string) => images.get(id)
  const canDiscard = (entry: Entry) =>
    !!me.data &&
    entry.batch.kind === 'shared-draft' &&
    canEdit(entry.batch, me.data) &&
    editableStates.includes(entry.batch.state)
  async function discard(entry: Entry, target: DraftChangeTarget) {
    if (!canDiscard(entry)) return
    const plateId = entry.baseline.id
    setReverting(true)
    setRevertFeedback(null)
    try {
      await actions.discardPlateChanges(
        entry.batch.id,
        plateId,
        entry.batch.revision,
        target
      )
      setRevertFeedback({
        plateId,
        message:
          target === 'all'
            ? `Removed all draft changes for ${entry.proposed.displayName}.`
            : `Removed the draft change for ${entry.proposed.displayName}.`,
        error: false,
      })
    } catch (error) {
      setRevertFeedback({
        plateId,
        message:
          apiErrorReasons(error).join(' ') ||
          reviewError(error, entry.batch.revision),
        error: true,
      })
    } finally {
      setReverting(false)
    }
  }
  if (batchId === '')
    return (
      <p role="alert">
        This Batch is unavailable.{' '}
        <Link href="/review?view=states">Choose another Batch</Link>
      </p>
    )
  return (
    <div className="grid min-h-[calc(100dvh-var(--header-h)-var(--space-6)*2)] min-w-0 grid-cols-1 gap-4 md:h-[calc(100dvh-var(--header-h)-var(--space-6)*2)] md:grid-cols-[200px_290px_minmax(0,1fr)]">
      <aside
        className={cn(
          'min-h-0 overflow-y-auto rounded-3xl bg-card p-3 md:block',
          mobile !== 'states' && 'hidden'
        )}
      >
        {!batchId &&
          batches.map((batch) => (
            <BatchLoader key={batch.id} batch={batch} onLoad={loaded} />
          ))}
        <h1 className="p-2 text-xs font-extrabold">
          {batchId
            ? (selected.data?.batch.name ?? 'Batch')
            : 'Unpublished changes'}
        </h1>
        {batchId && (
          <>
            <Link className="block px-2 pb-2 text-xs underline" href="/review">
              Unpublished changes
            </Link>
            <p
              className="px-2 pb-2 text-xs text-muted-foreground"
              role="status"
            >
              {live}
            </p>
            {live === 'Live updates unavailable' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void selected.mutate()}
              >
                Refresh Batch
              </Button>
            )}
          </>
        )}
        <nav aria-label="Review states" className="grid gap-1">
          <StateVisibilityControl
            value={stateVisibility}
            onChange={setStateVisibility}
          />
          <Link
            className={cn(
              'flex min-h-10 items-center justify-between rounded-xl px-2 text-sm',
              !scope && 'bg-primary text-primary-foreground'
            )}
            href={reviewHref(undefined, undefined, batchId ?? undefined, {
              ...filters,
              scope: null,
            })}
          >
            All changes <span>{byPlate.size}</span>
          </Link>
          {!shownStates.length && !loading && (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              No states with changes
            </p>
          )}
          {shownStates.map((item) => {
            const count = stateCounts.get(item.code)
            return (
              <Link
                key={item.code}
                href={reviewHref(item.code, undefined, batchId ?? undefined, {
                  ...filters,
                  scope: null,
                })}
                className={cn(
                  'flex min-h-10 items-center gap-3 rounded-xl px-2 text-sm',
                  scope === item.code && 'bg-primary text-primary-foreground'
                )}
              >
                <strong>{item.code}</strong>
                <span className="flex-1">{item.name}</span>
                {count !== undefined && (
                  <span className="rounded-full bg-[var(--info-tint)] px-2 text-[var(--ink)]">
                    {count}
                  </span>
                )}
                <IoChevronForward aria-hidden="true" />
              </Link>
            )
          })}
        </nav>
      </aside>
      <section
        aria-label="Plates"
        className={cn(
          'min-h-0 min-w-0 flex-col rounded-3xl bg-card p-3 md:flex',
          mobile === 'plates' ? 'flex' : 'hidden'
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
          <h2 className="font-extrabold">
            {batchId
              ? (selected.data?.batch.name ?? 'Batch')
              : (state?.name ?? 'Plates')}
          </h2>
          <span className="text-xs text-muted-foreground">
            {batchId ? byPlate.size : listed.length} changed{' '}
            {(batchId ? byPlate.size : listed.length) === 1
              ? 'Plate'
              : 'Plates'}
          </span>
        </div>
        {(batchId || byPlate.size > 0) && (
          <div className="grid gap-2 pb-3 text-sm">
            {batchId && (filters.run || since !== null) && (
              <div className="flex flex-wrap justify-between gap-2 text-xs">
                <span>{filters.run ? 'Run changes' : 'New changes'}</span>
                <Link
                  className="underline"
                  href={reviewHref(undefined, undefined, batchId)}
                >
                  Show all Batch changes
                </Link>
              </div>
            )}
            {filters.run &&
              me.data &&
              selected.data?.batch.kind === 'shared-draft' && (
                <ReviewRunRevertButton key={filters.run} runId={filters.run} />
              )}
            {filters.run && !loading && !byPlate.size && (
              <p className="caption">This run has no saved draft changes.</p>
            )}
            <div className="grid gap-2 md:hidden">
              <StateVisibilityControl
                value={stateVisibility}
                onChange={setStateVisibility}
              />
              <label>
                <span className="sr-only">Filter by state</span>
                <select
                  className="w-full rounded-xl border border-[var(--hairline)] bg-card p-2"
                  value={scope ?? ''}
                  onChange={(event) =>
                    router.push(
                      reviewHref(
                        event.target.value,
                        undefined,
                        batchId ?? undefined,
                        { ...filters, scope: null }
                      )
                    )
                  }
                >
                  <option value="">All changes</option>
                  {scope &&
                    !shownStates.some((item) => item.code === scope) && (
                      <option value={scope} hidden>
                        {state?.name ?? scope}
                      </option>
                    )}
                  {shownStates.map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <input
              className="rounded-xl border border-[var(--hairline)] bg-card p-2"
              type="search"
              aria-label="Search changed plates"
              placeholder="Search plates"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        )}
        <div className="max-h-[75dvh] min-h-0 flex-1 overflow-y-auto md:max-h-full">
          {listed.slice(0, pageEnd).map((group) => {
            const item = group[0]
            const plate = item.proposed
            const imageUrl =
              item.afterImageUrl ?? item.beforeImageUrl ?? plateImage(plate.id)
            const selected = entry?.baseline.id === plate.id
            const key = plate.id
            const summary = [
              ...new Set(
                group.map((change) =>
                  changeSummary(change.baseline, change.proposed, change.order)
                )
              ),
            ].join(' · ')
            const row = (
              <Link
                key={key}
                aria-label={`${plate.displayName} · ${item.baseline.state}`}
                title={summary}
                aria-current={selected ? 'true' : undefined}
                prefetch={false}
                href={
                  batchId
                    ? reviewHref(item.baseline.state, plate.id, item.batch.id, {
                        ...filters,
                        scope,
                      })
                    : reviewHref(
                        code ?? undefined,
                        plate.id,
                        undefined,
                        group.length === 1
                          ? { focusBatch: item.batch.id }
                          : undefined
                      )
                }
                className={cn(
                  'flex min-h-14 items-center gap-2 rounded-xl p-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary',
                  selected && 'bg-muted'
                )}
              >
                {imageUrl && filters.run ? (
                  // A run's rows already open a change preview with the image on hover.
                  <PlateImageHover
                    plateId={plate.id}
                    plateName={plate.displayName}
                    before={imageUrl}
                  >
                    <Image
                      unoptimized
                      src={imageUrl}
                      alt=""
                      width={80}
                      height={40}
                      className="h-10 w-20 shrink-0 object-contain"
                    />
                  </PlateImageHover>
                ) : imageUrl ? (
                  <PlateHoverPreview plate={plate} imageUrl={imageUrl}>
                    <Image
                      unoptimized
                      src={imageUrl}
                      alt=""
                      width={80}
                      height={40}
                      className="h-10 w-20 shrink-0 object-contain"
                    />
                  </PlateHoverPreview>
                ) : (
                  <span className="h-10 w-20 shrink-0 rounded bg-muted" />
                )}
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm">
                    {plate.displayName}
                  </strong>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {batchId && (
                      <span className="text-xs text-muted-foreground">
                        {item.baseline.state}
                      </span>
                    )}
                    <PlateChangeIcons entries={group} />
                  </span>
                </span>
                {!batchId && <Author {...changeAuthor(item)} />}
              </Link>
            )
            if (!filters.run) return row
            return (
              <HoverCard.Root key={key} openDelay={500}>
                <HoverCard.Trigger asChild>{row}</HoverCard.Trigger>
                <HoverCard.Portal>
                  <HoverCard.Content
                    side="right"
                    align="start"
                    sideOffset={8}
                    collisionPadding={12}
                    className="z-50 grid max-h-[var(--radix-hover-card-content-available-height)] w-[min(420px,calc(100vw-24px))] gap-2 overflow-auto rounded-2xl border bg-card p-3 shadow-xl"
                  >
                    {imageUrl && (
                      <PlateEnhancementPreview
                        plateId={plate.id}
                        plateName={plate.displayName}
                        before={imageUrl}
                      >
                        <Image
                          src={imageUrl}
                          alt={plate.displayName}
                          width={208}
                          height={104}
                          unoptimized
                          className="h-24 w-52 object-contain"
                        />
                      </PlateEnhancementPreview>
                    )}
                    <strong className="text-sm">{plate.displayName}</strong>
                    <DiffTable
                      compact
                      preview
                      before={item.baseline}
                      after={plate}
                      beforeImageUrl={item.beforeImageUrl}
                      afterImageUrl={item.afterImageUrl}
                      version={item.batch.baselineVersion}
                      revision={item.batch.revision}
                      order={[]}
                      positions={item.order}
                      pipelineChanges={item.edit?.pipelineChanges}
                    />
                  </HoverCard.Content>
                </HoverCard.Portal>
              </HoverCard.Root>
            )
          })}
          {pageEnd < listed.length && (
            <Button
              variant="outline"
              size="sm"
              className="mx-2 my-3"
              onClick={() =>
                setPagination({
                  scope: pageScope,
                  count: pageEnd + reviewPageSize,
                })
              }
            >
              Load more plates
            </Button>
          )}
          {term && !listed.length && (
            <p className="p-2 text-sm">No plates match your search.</p>
          )}
        </div>
      </section>
      <section
        aria-label="Before and after"
        className={cn(
          'flex min-h-0 min-w-0 flex-col gap-4 rounded-3xl bg-card p-4 [overflow-wrap:anywhere] md:overflow-y-auto',
          mobile !== 'detail' && 'hidden md:flex'
        )}
      >
        <Link
          href={reviewHref(
            scope ?? undefined,
            undefined,
            batchId ?? undefined,
            { ...filters, scope: null }
          )}
          className="flex items-center text-xs md:hidden"
        >
          <IoChevronBack />
          Plates
        </Link>
        {revertFeedback &&
          (!revertFeedback.error ||
            revertFeedback.plateId === entry?.baseline.id ||
            revertFeedback.plateId === plateId) && (
            <p role={revertFeedback.error ? 'alert' : 'status'}>
              {revertFeedback.message}
            </p>
          )}
        {recent.error ? (
          <div role="alert">
            <p>Could not load new changes.</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void recent.mutate()}
            >
              Retry
            </Button>
          </div>
        ) : recent.isLoading ? (
          <p role="status">Loading new changes…</p>
        ) : entry ? (
          <>
            <header className="flex flex-wrap items-center gap-3">
              {(entry.afterImageUrl ??
                entry.beforeImageUrl ??
                plateImage(entry.baseline.id)) && (
                <PlateHoverPreview
                  plate={entry.proposed}
                  imageUrl={
                    (entry.afterImageUrl ??
                      entry.beforeImageUrl ??
                      plateImage(entry.baseline.id))!
                  }
                >
                  <Image
                    unoptimized
                    src={
                      (entry.afterImageUrl ??
                        entry.beforeImageUrl ??
                        plateImage(entry.baseline.id))!
                    }
                    alt={entry.proposed.displayName}
                    width={160}
                    height={80}
                    className="h-20 w-40 object-contain"
                  />
                </PlateHoverPreview>
              )}
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-extrabold">
                  {entry.proposed.displayName}
                </h2>
                <PlateChangeIcons entries={comparisons} />
              </div>
            </header>
            {comparisons.map((item) => {
              const editable = canDiscard(item)
              const runIds = new Set(
                Object.values(item.edit?.pipelineChanges ?? {}).map(
                  (change) => change.runId
                )
              )
              return (
                <section
                  key={`${item.baseline.id}-${item.batch.id}`}
                  aria-label={`Changes in ${item.batch.name}`}
                  className="grid gap-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs text-muted-foreground">
                      <h3 className="font-bold">{item.batch.name}</h3>
                      <BatchLastChanged batch={item.batch} />
                    </div>
                    {editable &&
                      (item.order ||
                        Object.keys(item.edit?.fields ?? {}).length > 0) && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={reverting}
                              className="text-[var(--danger)]"
                            >
                              Remove all changes
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                Remove all changes for{' '}
                                {item.proposed.displayName}?
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                This clears this plate’s draft edits in{' '}
                                {item.batch.name} and restores its catalog
                                position if it was moved.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                variant="outline"
                                className="text-[var(--danger)]"
                                onClick={() => void discard(item, 'all')}
                              >
                                Remove all changes
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                  </div>
                  {editable && !filters.run && runIds.size > 0 && (
                    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      {[...runIds].map((runId) => (
                        <li key={runId}>
                          <Link
                            className="underline"
                            href={reviewHref(
                              undefined,
                              undefined,
                              item.batch.id,
                              { run: runId }
                            )}
                          >
                            Review pipeline run {runId.slice(-8)}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                  <DiffTable
                    compact
                    before={item.baseline}
                    beforeImageUrl={
                      item.beforeImageUrl ?? plateImage(item.baseline.id)
                    }
                    afterImageUrl={item.afterImageUrl}
                    after={item.proposed}
                    version={item.batch.baselineVersion}
                    revision={item.batch.revision}
                    positions={item.order}
                    order={
                      state?.code === item.baseline.state
                        ? state.plates.map((plate) => plate.id)
                        : []
                    }
                    pipelineChanges={item.edit?.pipelineChanges}
                    reverting={reverting}
                    onDiscard={
                      editable
                        ? (target) => void discard(item, target)
                        : undefined
                    }
                  />
                  <RunStatus compact batchId={item.batch.id} />
                  <ReviewFooter detail={currentDetails[item.batch.id]!} />
                </section>
              )
            })}
          </>
        ) : (batchId ? selected.error : open.error) ? (
          <p role="alert">Could not load review batches. Please refresh.</p>
        ) : loading ? (
          <p role="status">Loading review batches…</p>
        ) : (
          <div className="m-auto text-center">
            <h2 className="text-lg font-extrabold">
              {filters.run
                ? 'This run has no saved draft changes'
                : since !== null
                  ? 'No new changes in this Batch'
                  : plateId
                    ? 'No changes for this plate'
                    : batchId
                      ? 'No draft changes in this Batch'
                      : 'No unpublished changes'}
            </h2>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              <Link
                href={
                  batchId && (filters.run || since !== null)
                    ? reviewHref(undefined, undefined, batchId)
                    : batchHref(
                        '/',
                        batchId && isSharedDraftId(batchId) ? batchId : null
                      )
                }
                className="underline"
              >
                {batchId && (filters.run || since !== null)
                  ? 'Show all Batch changes'
                  : 'Dashboard'}
              </Link>
              {batchId ? (
                <Link href="/review" className="underline">
                  All review changes
                </Link>
              ) : (
                <Link
                  href="/review?view=states"
                  className="underline md:hidden"
                >
                  Browse states
                </Link>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
