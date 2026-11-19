'use client'

import { familyRole } from '@/lib/catalog/families'

import type { ReviewChanges } from '../review/checkpoint'
import type { RunStatus } from '../review/run-status'

import {
  PIPELINE_BUSY,
  PIPELINE_BUSY_MESSAGE,
  PUBLISH_ERRORS,
  PUBLISH_STOP_MESSAGES,
} from '../publish/stop'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import type { PlateCardData, PlateDetail } from '../catalog/dashboard-types'
import { isComplete, plateChecks } from '../catalog/plate-checks'
import useSWR, { preload, useSWRConfig } from 'swr'
import type { Plate, StoryFields } from '../catalog/types'
import type { StatePublishSummary } from '../review/publish-view'
import type {
  Actor,
  BatchState,
  DraftConflict,
  LastPublish,
  DraftChangeTarget,
  EditableFields,
  ProposedEdit,
  ReviewBatch,
  StandardChange,
} from '../review/types'
import type { StateMove } from '../review/state-move'
import type { PlateFieldConflicts } from '../review/types'
import type { FamilyMerge } from '../review/family-merge'
import type { FamilyMergeResult } from '../review/family-merge-plan'
import { sameEditableValue } from '../review/story'
import { canEdit, editableStates } from '../review/access'
import { isSharedDraft } from '../review/draft-id'
import { BASELINE_ERRORS, type BaselineError } from '../publish/baseline'
import type {
  Abandonment,
  PublishControlState,
  PublishStop,
  RequesterAuthority,
} from '../publish/types'
import { ApiError, apiErrorReasons, batchApiPath, type ApiClient } from './api'
import { useSession } from './session'
import type { MemberInvite, MemberSummary } from '../members/summary'
import { DRAFT_TOO_LARGE_MESSAGE } from '../review/write-budget'

export type BatchDetail = {
  batch: ReviewBatch
  plates: {
    beforeImageUrl?: string | null
    afterImageUrl?: string | null
    baseline: Plate
    proposed: Plate
    edit: ProposedEdit | null
    revision: string
    order?: { before: number; after: number; total: number }
  }[]
}

/** Build the batch list cache key from its state and creation filters. */
export function batchesKey(states?: BatchState[], opts?: { mine?: boolean }) {
  const params = []
  if (states?.length) params.push(`state=${states.join(',')}`)
  if (opts?.mine) params.push('mine=1')
  return `/api/batches${params.length ? `?${params.join('&')}` : ''}`
}

/** The signed-in member plus the id of this environment's shared working draft. */
export type Me = Actor & { draftId?: string }

/** Fetch the signed-in user's current membership and environment. */
export function useMe(enabled = true) {
  const { user, api } = useSession()
  // Share membership across session consumers and reuse it on remount when cached.
  return useSWR<Me>(user && enabled ? '/api/me' : null, api.get, {
    revalidateIfStale: false,
    dedupingInterval: 30000,
  })
}

/** The shared working draft every curator edits, or null until membership loads. */
export function useSharedDraftId() {
  return useMe().data?.draftId ?? null
}

/** Load the member list only for a signed-in owner. */
export function useMembers() {
  const { user, api } = useSession()
  const me = useMe()
  // Share the owner-only list across controls and refresh it after member writes.
  return useSWR<MemberSummary[]>(
    user && me.data?.role === 'owner' ? '/api/members' : null,
    api.get
  )
}

/** Issue a membership invitation and refresh the member list after it succeeds. */
export function useInviteMember() {
  const { api } = useSession()
  const { mutate } = useSWRConfig()
  return async (email: string, role: MemberSummary['role']) => {
    const result = await api.send<MemberInvite>('POST', '/api/members', {
      email,
      role,
    })
    await mutate('/api/members').catch(() => undefined)
    return result
  }
}

/** Read the filtered batch list after sign-in and reuse its SWR cache. */
export function useBatches(
  states?: BatchState[],
  opts?: { mine?: boolean; enabled?: boolean; refreshInterval?: number }
) {
  const { user, api } = useSession()
  // Keep each filter in its own entry and reuse open drafts across editing views.
  const reuse =
    states?.length === 1 &&
    states[0] === 'open' &&
    opts?.mine &&
    !opts.refreshInterval
  return useSWR<ReviewBatch[]>(
    user && opts?.enabled !== false ? batchesKey(states, opts) : null,
    api.get,
    {
      refreshInterval: opts?.refreshInterval,
      ...(reuse && { revalidateIfStale: false, dedupingInterval: 30000 }),
    }
  )
}

/**
 * Read all batch detail pages at a consistent revision, retrying when the batch changes
 * during pagination.
 */
async function fetchBatchDetail(
  api: ApiClient,
  key: string
): Promise<BatchDetail> {
  type Page = BatchDetail & { nextPage?: string }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const first = await api.get<Page>(key)
    const { batch, nextPage } = first
    if (!nextPage) return first
    const plates = [...first.plates]
    let cursor: string | undefined = nextPage
    try {
      while (cursor) {
        const page: Page = await api.get<Page>(
          `${key}?page=${encodeURIComponent(cursor)}`
        )
        if (page.batch.revision !== batch.revision)
          throw new ApiError(409, 'superseded_revision', {})
        plates.push(...page.plates)
        cursor = page.nextPage
      }
      return { batch, plates }
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.code !== 'superseded_revision' ||
        attempt === 2
      )
        throw error
    }
  }
  throw new ApiError(409, 'superseded_revision', {})
}

function preferCurrentBatch(
  current: BatchDetail | undefined,
  fetched: BatchDetail
): BatchDetail {
  return current && current.batch.revision > fetched.batch.revision
    ? current
    : fetched
}

/**
 * Cache the assembled batch by ID. Editing views can reuse it on mount because
 * mutations and live revision signals refresh the shared entry.
 */
export function useBatch(id: string | null, opts?: { reuse?: boolean }) {
  const { user, api } = useSession()
  const { cache } = useSWRConfig()
  return useSWR<BatchDetail>(
    user && id ? batchApiPath(id) : null,
    async (key) => {
      const fetched = await fetchBatchDetail(api, key)
      return preferCurrentBatch(cache.get(key)?.data, fetched)
    },
    opts?.reuse ? { revalidateIfStale: false } : undefined
  )
}

export type BatchRun = RunStatus

// Share the post-submit polling deadline by batch so remounts still watch for startup.
const publishWindows = new Map<string, number>()

/**
 * Track a batch's approval or publish run and refresh the workspace when publishing
 * advances.
 */
export function useBatchRun(id: string | null) {
  const router = useRouter()
  const previousRun = useRef<{
    id: string | null
    phase: BatchRun['phase'] | undefined
  }>({ id: null, phase: undefined })
  const { user, api } = useSession()
  const me = useMe()
  const { mutate } = useSWRConfig()
  const [pendingUntil, setPendingUntil] = useState(0)
  useEffect(() => {
    /**
     * Read the pending publish window so polling can continue while the workflow starts.
     */
    const update = () => setPendingUntil(publishWindows.get(id ?? '') ?? 0)
    update()
    window.addEventListener('batch-publish-requested', update)
    return () => window.removeEventListener('batch-publish-requested', update)
  }, [id])
  // Share each batch's run status between review and publish as polling updates it.
  const run = useSWR<BatchRun>(
    user && me.data?.role === 'owner' && id ? `${batchApiPath(id)}/run` : null,
    api.get,
    {
      /**
       * Poll during active publishing and the short window immediately after a publish
       * request.
       */
      refreshInterval: (data) =>
        data?.phase === 'publishing' ||
        (data?.phase === 'waiting-for-publish' && pendingUntil > Date.now())
          ? 2000
          : 0,
    }
  )
  useEffect(() => {
    const phase = run.data?.phase
    const previous = previousRun.current
    previousRun.current = { id, phase }
    // Refresh the browser's route payload when the new catalog is published.
    if (
      id &&
      previous.id === id &&
      previous.phase != null &&
      previous.phase !== 'published' &&
      phase === 'published'
    )
      router.refresh()
    if (
      id &&
      run.data?.phase &&
      ['published', 'failed', 'superseded', 'timed-out'].includes(
        run.data.phase
      )
    ) {
      publishWindows.delete(id)
      void mutate(
        (key) =>
          typeof key === 'string' &&
          (key === '/api/batches' ||
            key.startsWith('/api/batches?') ||
            key === batchApiPath(id) ||
            key === `${batchApiPath(id)}/publish`)
      ).catch(() => undefined)
    }
  }, [id, run.data?.phase, mutate, router])
  return run
}

/** Build the shared cache key for fetching and preloading a plate detail. */
export const plateDetailKey = (id: string) => `/api/plates/${id}`

/** Share plate detail by endpoint so preview hooks can reuse the same response. */
export function usePlateDetail(id: string | null) {
  const { user, api } = useSession()
  return useSWR<PlateDetail>(user && id ? plateDetailKey(id) : null, api.get)
}

/** Start the detail request early so SWR can reuse its promise under the same key. */
export function usePreloadPlateDetail() {
  const { user, api } = useSession()
  return (id: string) => {
    if (user) preload(plateDetailKey(id), api.get).catch(() => undefined)
  }
}

export type PublishBaselineStatus = {
  batchRevision: number
  destination: string | null
  enabledHere: boolean
  approvalProblems: string[]
  pipelineBusy?: boolean
  canConfirmDraft?: boolean
  confirmation?: ReviewChanges | null
  canAbandon?: boolean
  abandonReason?: string | null
  prepared?: { commandId: string; toVersion: number }
  abandonment?: Abandonment
  canRetry?: boolean
  retryReason?: string | null
  stopped?: { reason: PublishStop; requestedBy?: RequesterAuthority }
} & (
  | {
      error: BaselineError | null
      reviewedVersion: number
      liveVersion: number
    }
  | { error: PublishStop; reviewedVersion?: never; liveVersion?: never }
)

/** Share publish controls between views and poll so external pause changes appear. */
export function usePublishControl() {
  const { user, api } = useSession()
  const { mutate } = useSWRConfig()
  const status = useSWR<{
    control: PublishControlState | null
    enabledHere: boolean
  }>(user ? '/api/publish/control' : null, api.get, { refreshInterval: 30000 })
  return {
    ...status,
    async change(paused: boolean) {
      const result = await api.send<{ control: PublishControlState }>(
        'POST',
        '/api/publish/control',
        { paused }
      )
      // Seed the cache from the write response and recheck affected eligibility entries.
      await status.mutate(
        { ...result, enabledHere: true },
        { revalidate: false }
      )
      await mutate(
        (key) =>
          typeof key === 'string' &&
          key.startsWith('/api/batches/') &&
          key.endsWith('/publish')
      ).catch(() => undefined)
    },
  }
}

/**
 * Share publish eligibility by batch and poll while active pipeline work can change it.
 */
export function usePublishBaseline(id: string | null) {
  const { user, api } = useSession()
  return useSWR<PublishBaselineStatus>(
    user && id ? `${batchApiPath(id)}/publish` : null,
    api.get,
    {
      refreshInterval: (data) =>
        data?.pipelineBusy || data?.retryReason === 'locked' ? 5000 : 0,
    }
  )
}

/** The Owner's Publish view of the shared draft (`GET /api/batches/<draft>/publish`). */
export type DraftPublishView = {
  error?: string | null
  reviewedVersion?: number
  liveVersion?: number
  draftId: string
  draftRevision: number
  baselineVersion: number
  destination: string | null
  enabledHere: boolean
  states: StatePublishSummary[]
  pipeline: { busy: boolean; activeRuns?: number }
  approvalProblems: string[]
  lastPublish?: LastPublish
  activeRelease?: { id: string; revision?: number }
  /** A release that stopped after preparing its Snapshot; retry or abandon it first. */
  interruptedRelease?: { id: string; revision?: number }
  /** Pending values an outside catalog change touched; Publish waits on them. */
  conflicts?: DraftConflict[]
  canPublish: boolean
}

/**
 * Poll the shared draft's Publish view so the revision, per-state breakdown and the
 * pipeline-busy count stay current while curators keep editing.
 */
export function useDraftPublishView(draftId: string | null) {
  const { user, api } = useSession()
  return useSWR<DraftPublishView>(
    user && draftId ? `${batchApiPath(draftId)}/publish` : null,
    api.get,
    { refreshInterval: 5000 }
  )
}

/** Expose batch review actions and keep related caches synchronized after writes. */
export function useReviewActions() {
  const { api } = useSession()
  const { mutate } = useSWRConfig()
  // Reuse the command ID if the same batch revision must be submitted again.
  const publishIntents = useRef(new Map<string, string>())
  /** Refresh batch lists and, when specified, details for the changed batch. */
  const refresh = (batchId?: string) =>
    mutate(
      (key) =>
        typeof key === 'string' &&
        (key.startsWith('/api/batches?') ||
          key === '/api/batches' ||
          (batchId !== undefined && key === batchApiPath(batchId)))
    )

  return {
    /**
     * Abandon a prepared receipt and refresh the review and publish views after the
     * attempt.
     */
    async abandon(
      batchId: string,
      revision: number,
      commandId: string,
      reason: string
    ) {
      try {
        await api.send('POST', `${batchApiPath(batchId)}/abandon`, {
          revision,
          commandId,
          reason,
        })
      } finally {
        await Promise.all([
          refresh(batchId),
          mutate(`${batchApiPath(batchId)}/publish`),
        ]).catch(() => undefined)
      }
    },
    /**
     * Submit an idempotent publish intent and prompt the batch run to poll for workflow
     * progress.
     */
    async publish(
      batchId: string,
      revision: number
    ): Promise<
      | { ok: true }
      | {
          ok: false
          message: string
          code?: string
          confirmation?: ReviewChanges | null
          reviewedVersion?: number
          liveVersion?: number
        }
    > {
      const key = `${batchId}@${revision}`
      const commandId = publishIntents.current.get(key) ?? crypto.randomUUID()
      publishIntents.current.set(key, commandId)
      try {
        await api.send<{ status: 'publishing' }>(
          'POST',
          `${batchApiPath(batchId)}/publish`,
          { revision, commandId }
        )
        publishIntents.current.delete(key)
        publishWindows.set(batchId, Date.now() + 30000)
        window.dispatchEvent(new Event('batch-publish-requested'))
        await Promise.all([
          refresh(batchId),
          mutate(`${batchApiPath(batchId)}/run`),
          mutate(`${batchApiPath(batchId)}/publish`),
        ]).catch(() => undefined)
        return { ok: true }
      } catch (error) {
        if (error instanceof ApiError && error.status < 500)
          publishIntents.current.delete(key)
        const messages: Record<string, string> = {
          [BASELINE_ERRORS.stale]:
            'The Catalog changed since this revision. Reload the Publish view and try again.',
          [BASELINE_ERRORS.receiptConflict]:
            'The interrupted Publish used an unreviewed baseline. Investigate the receipt before publishing again.',
          ...PUBLISH_STOP_MESSAGES,
          [PIPELINE_BUSY]: PIPELINE_BUSY_MESSAGE,
          empty_batch: 'The draft has no changes to publish.',
          empty_draft: 'The draft has no changes to publish.',
          draft_too_large: DRAFT_TOO_LARGE_MESSAGE,
          draft_conflicts:
            'Changes made outside this draft touched values it would publish. Check the conflicts in the Publish view.',
          standard_change_unconfirmed:
            apiErrorReasons(error).join(' ') ||
            'Resolve the Standard plate changes before publishing.',
          publish_disabled_here: 'Publishing is disabled in this environment.',
          superseded_revision:
            'The draft moved past this revision. Reload the Publish view and confirm the current revision.',
          [PUBLISH_ERRORS.notWaiting]:
            'This run is no longer waiting for Publish. Refresh to see its status.',
          release_in_progress:
            'An earlier revision is still publishing or waits for Retry or Abandon. Reload the Publish view to follow it.',
          forbidden: 'Only the Owner can Publish.',
          not_found: 'The draft could not be found.',
        }
        await Promise.all([
          refresh(batchId),
          mutate(`${batchApiPath(batchId)}/run`),
          mutate(`${batchApiPath(batchId)}/publish`),
        ]).catch(() => undefined)
        const code = error instanceof ApiError ? error.code : undefined
        return {
          ok: false,
          ...(code === 'superseded_revision' || code === PIPELINE_BUSY
            ? { code }
            : {}),
          ...(error instanceof ApiError && error.body.confirmation
            ? { confirmation: error.body.confirmation as ReviewChanges }
            : {}),
          ...(error instanceof ApiError &&
          typeof error.body.liveVersion === 'number'
            ? {
                reviewedVersion: error.body.reviewedVersion as number,
                liveVersion: error.body.liveVersion,
              }
            : {}),
          message:
            error instanceof ApiError
              ? (messages[error.code] ?? 'Could not Publish. Please try again.')
              : 'Could not Publish. Please try again.',
        }
      }
    },
    /**
     * Keep the draft's pending values over the outside catalog changes the Owner was
     * shown at this revision, then refresh the Publish view.
     */
    async keepDraftValues(
      draftId: string,
      revision: number
    ): Promise<{ ok: true } | { ok: false; message: string }> {
      try {
        await api.send('POST', `${batchApiPath(draftId)}/conflicts`, {
          revision,
        })
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof ApiError && error.code === 'superseded_revision'
              ? 'The draft changed since you looked. Check the conflicts again.'
              : error instanceof ApiError && error.code === 'forbidden'
                ? 'Only the Owner can keep these values.'
                : 'Could not save. Please try again.',
        }
      } finally {
        await Promise.all([
          refresh(draftId),
          mutate(`${batchApiPath(draftId)}/publish`),
        ]).catch(() => undefined)
      }
    },
    /** Save a proposed plate edit and refresh the batch detail used by review. */
    async propose(
      batchId: string,
      plateId: string,
      baseRevision: string,
      fields: EditableFields
    ) {
      const result = await api.send<{ batch: ReviewBatch; plate: Plate }>(
        'PATCH',
        `${batchApiPath(batchId)}/plates/${plateId}`,
        { baseRevision, fields }
      )
      await refresh(batchId)
      return result
    },
    /**
     * Revert a pipeline field and refresh the batch even when the server reports a
     * conflict.
     */
    async revertPipelineField(
      batchId: string,
      plateId: string,
      field: keyof EditableFields,
      jobId: string
    ) {
      try {
        return await api.send<{ batch: ReviewBatch; plate: Plate }>(
          'PATCH',
          `${batchApiPath(batchId)}/plates/${encodeURIComponent(plateId)}`,
          { revert: field, jobId }
        )
      } finally {
        await refresh(batchId).catch(() => undefined)
      }
    },
    async discardPlateChanges(
      batchId: string,
      plateId: string,
      batchRevision: number,
      discard: DraftChangeTarget
    ) {
      try {
        await api.send<ReviewBatch>(
          'PATCH',
          `${batchApiPath(batchId)}/plates/${encodeURIComponent(plateId)}`,
          { batchRevision, discard }
        )
      } finally {
        await refresh(batchId).catch(() => undefined)
      }
    },
  }
}

export type OverlaidPlate = PlateCardData &
  StoryFields & { changedInBatch: boolean }

/** Read the active batch selection from the current URL. */
export function useSelectedBatchId() {
  return useSearchParams()?.get('batch') ?? null
}

/**
 * Resolve the URL's batch and its editability for the workspace. Without `?batch=` the
 * workspace edits the shared draft (`mode: 'personal'` is kept as the name of that
 * default so call sites stay stable). A linked release or pre-draft Batch is read-only
 * history; only the shared draft is editable.
 */
export function useWorkspaceBatch() {
  const id = useSelectedBatchId()
  const detail = useBatch(id, { reuse: true })
  const me = useMe(id !== null)
  if (id === null) return { mode: 'personal' as const }
  const status =
    id === '' || detail.error || me.error
      ? 'unavailable'
      : !detail.data || !me.data
        ? 'loading'
        : isSharedDraft(detail.data.batch) &&
            canEdit(detail.data.batch, me.data) &&
            editableStates.includes(detail.data.batch.state)
          ? 'ready'
          : 'read-only'
  return { mode: 'selected' as const, id, detail: detail.data, status }
}

/**
 * Overlay the shared draft's (or a linked history Batch's) fields and ordering on the
 * catalog plates. "Changed in a batch" marks everything in the draft that differs from
 * live, whoever made the change.
 */
export function useDraftOverlay(plates: PlateCardData[]): OverlaidPlate[] {
  const { user, api } = useSession()
  const draftId = useSharedDraftId()
  const workspace = useWorkspaceBatch()
  const personal = useBatch(workspace.mode === 'personal' ? draftId : null, {
    reuse: true,
  })
  const detail =
    workspace.mode === 'selected' ? workspace.detail : personal.data
  const jurisdictions = useMemo(
    () => [...new Set(plates.map((plate) => plate.state))].sort().join(','),
    [plates]
  )
  const { data } = useSWR<{ drafts: BatchDetail[] }>(
    user && jurisdictions ? `/api/batches?dashboard=${jurisdictions}` : null,
    api.get,
    {
      revalidateIfStale: false,
    }
  )

  // Reuse projected cards and checks until the catalog plates or batch details change.
  return useMemo(() => {
    const entries = new Map(
      detail?.plates.map((entry) => [entry.proposed.id, entry])
    )
    const drafts = new Map(
      data?.drafts?.map((draft) => [draft.batch.id, draft])
    )
    if (
      detail &&
      (drafts.get(detail.batch.id)?.batch.revision ?? -1) <=
        detail.batch.revision
    )
      drafts.set(detail.batch.id, detail)
    const orders = new Map<
      string,
      { at: string; dated: boolean; positions: Map<string, number> }
    >()
    const changes = new Map<
      string,
      {
        batchId: string
        entry: BatchDetail['plates'][number] & { edit: ProposedEdit }
      }[]
    >()
    for (const draft of drafts.values()) {
      const { batch } = draft
      for (const [state, order] of Object.entries(batch.stateOrders)) {
        const savedAt = batch.stateOrderChangedAt?.[state]
        const at = savedAt ?? batch.lastChangedAt ?? batch.createdAt
        const dated = savedAt !== undefined
        const current = orders.get(state)
        if (!current || (current.dated === dated ? current.at <= at : dated)) {
          orders.set(state, {
            at,
            dated,
            positions: new Map(order.map((id, index) => [id, index])),
          })
        }
      }
      for (const entry of draft.plates) {
        if (!entry.edit || !Object.keys(entry.edit.fields).length) continue
        const plateChanges = changes.get(entry.proposed.id) ?? []
        plateChanges.push({
          batchId: batch.id,
          entry: { ...entry, edit: entry.edit },
        })
        changes.set(entry.proposed.id, plateChanges)
      }
    }
    const activePositions = new Map(
      Object.entries(detail?.batch.stateOrders ?? {}).flatMap(([, order]) =>
        order.map((id, index) => [id, index] as const)
      )
    )
    return plates.map((card) => {
      const entry = entries.get(card.id)
      const positions = orders.get(card.state)?.positions
      const sortOrder = positions
        ? (positions.get(card.id) ?? positions.size + card.sortOrder)
        : card.sortOrder
      const ordered = { ...card, sortOrder }
      const reordered =
        activePositions.has(card.id) &&
        activePositions.get(card.id) !== card.sortOrder
      const plateChanges =
        changes
          .get(card.id)
          ?.sort((left, right) =>
            left.entry.edit.updatedAt.localeCompare(right.entry.edit.updatedAt)
          ) ?? []
      const latest = plateChanges.at(-1)
      const base = entry?.proposed ?? latest?.entry.baseline
      const changedInBatch =
        !!(entry?.edit && Object.keys(entry.edit.fields).length) || reordered
      if (!base) return { ...ordered, changedInBatch }
      const fields = Object.assign(
        {},
        ...plateChanges.map(({ entry }) => entry.edit.fields)
      ) as EditableFields
      const proposed: Plate = { ...base, ...fields }
      const imageUrl = fields.imageUrl ?? card.imageUrl
      const checks = plateChecks(proposed, imageUrl)
      const pipeline = plateChanges.findLast(({ entry }) =>
        Object.entries(entry.edit.pipelineChanges ?? {}).some(
          ([field, change]) =>
            sameEditableValue(field, change.value, proposed[field]) &&
            !sameEditableValue(field, entry.baseline[field], proposed[field])
        )
      )
      return {
        ...ordered,
        imageUrl,
        deleted: proposed.deleted === true,
        tags: proposed.tags,
        templateFamily: proposed.templateFamily ?? null,
        templateRole: familyRole(proposed),
        variantOfPlateId: proposed.variantOfPlateId ?? null,
        isStandard: proposed.isStandard ?? false,
        revision: entry?.revision ?? card.revision,
        checks,
        funFacts: proposed.funFacts ?? [],
        readMore: proposed.readMore ?? [],
        wikiUrl: proposed.wikiUrl ?? null,
        ...('firstIssuedYear' in card
          ? { firstIssuedYear: proposed.firstIssuedYear ?? null }
          : {}),
        ...('sourceUrl' in card
          ? { sourceUrl: proposed.sourceUrl ?? null }
          : {}),
        ...('colorDetail' in fields ? { colorDetail: fields.colorDetail } : {}),
        ...('lineageColor' in fields
          ? { lineageColor: fields.lineageColor }
          : {}),
        complete: isComplete(checks),
        changedInBatch,
        ...(pipeline ? { pipelineBatchId: pipeline.batchId } : {}),
      }
    })
  }, [plates, detail, data])
}

export type EditResult<T = Plate | void> =
  | ({
      ok: true
      revision?: string
      batchId?: string
      revisions?: Record<string, string>
    } & (T extends void ? object : { proposed: T }))
  | {
      ok: false
      error: 'stale_plate'
      current: Plate
      currentRevision: string
      batchId: string
      draft: EditableFields
      conflicts?: PlateFieldConflicts
    }
  | {
      ok: false
      error:
        | 'forbidden'
        | 'invalid_state'
        | 'not_found'
        | 'superseded_revision'
        | 'standard_change_unconfirmed'
        | 'standard_required'
        | 'standard_invalid_template'
      message?: string
    }

/**
 * Resolve the batch that edits land in: the shared draft. The draft is created on the
 * server the first time anyone reads or writes it, so there is nothing to create here.
 * The plate argument is kept for older call sites.
 */
export function useEnsureBatch(): (plate?: {
  id: string
  state: string
}) => Promise<string> {
  const { user, api } = useSession()
  const { cache, mutate } = useSWRConfig()
  const draftId = useSharedDraftId()
  return async () => {
    if (!user) throw new ApiError(401, 'unauthenticated', {})
    if (draftId) return draftId
    const me =
      (cache.get('/api/me')?.data as Me | undefined) ??
      (await mutate('/api/me', api.get<Me>('/api/me'), { revalidate: false }))
    if (!me?.draftId) throw new ApiError(404, 'not_found', {})
    return me.draftId
  }
}

/**
 * Expose a serialized plate editing action and pending state so drafts update in
 * submission order.
 */
export function useEditPlate({
  parallel = false,
}: { parallel?: boolean } = {}) {
  const { api } = useSession()
  const { cache, mutate } = useSWRConfig()
  const ensureBatch = useEnsureBatch()
  const workspace = useWorkspaceBatch()
  const [pendingCount, setPendingCount] = useState(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const localRevisions = useRef(
    new Map<string, { seen: string; saved: string }>()
  )

  /**
   * Save once against the expected revision and inspect refreshed detail when the server
   * reports a conflict.
   */
  async function save(
    plate: PlateCardData | OverlaidPlate,
    fields: EditableFields,
    reviewed?: {
      batchId: string
      baseRevision: string
      standard?: StandardChange
    },
    standard?: StandardChange
  ): Promise<EditResult<Plate>> {
    let batchId = reviewed?.batchId
    try {
      if (workspace.mode === 'selected' && workspace.status !== 'ready')
        return {
          ok: false,
          error: workspace.status === 'unavailable' ? 'not_found' : 'forbidden',
        }
      if (
        reviewed &&
        workspace.mode === 'selected' &&
        reviewed.batchId !== workspace.id
      )
        return { ok: false, error: 'not_found' }
      const id =
        reviewed?.batchId ??
        (workspace.mode === 'selected'
          ? workspace.id
          : await ensureBatch(plate))
      batchId = id
      const key = batchApiPath(id)
      // Reuse the open draft in SWR to pick the edit revision without another read.
      const detail =
        (cache.get(key)?.data as BatchDetail | undefined) ??
        (await fetchBatchDetail(api, key))
      const plateKey = key + '/plates/' + plate.id
      const lastLocal = localRevisions.current.get(plateKey)
      const cachedRevision = detail.plates.find(
        (entry) => entry.proposed.id === plate.id
      )?.revision
      const baseRevision =
        reviewed?.baseRevision ??
        (lastLocal &&
        lastLocal.seen === plate.revision &&
        lastLocal.saved === cachedRevision
          ? lastLocal.saved
          : plate.revision)
      if (!baseRevision)
        throw new Error(
          'Cannot save a plate without a revision. Reload and try again.'
        )
      const result = await api.send<{ batch: ReviewBatch; plate: Plate }>(
        'PATCH',
        `${key}/plates/${plate.id}`,
        {
          baseRevision,
          fields,
          ...((standard ?? reviewed?.standard)
            ? { standard: standard ?? reviewed?.standard }
            : {}),
        }
      )
      // Store the fresh assembled draft so other editors see the new field revisions.
      const saved = await mutate<BatchDetail>(key, fetchBatchDetail(api, key), {
        revalidate: false,
      })
      await mutate(
        (key) =>
          typeof key === 'string' &&
          (key === batchesKey() || key.startsWith(`${batchesKey()}?`))
      )
      const entry = saved?.plates.find(
        (entry) => entry.proposed.id === plate.id
      )
      const unchanged =
        entry &&
        Object.keys(fields).every(
          (key) =>
            JSON.stringify(entry.proposed[key]) ===
            JSON.stringify(result.plate[key])
        )
      if (
        entry &&
        !reviewed &&
        sameEditableValue('plate', entry.proposed, result.plate)
      )
        localRevisions.current.set(plateKey, {
          seen: plate.revision,
          saved: entry.revision,
        })
      return {
        ok: true,
        proposed: result.plate,
        batchId: id,
        revision: unchanged ? entry.revision : undefined,
      }
    } catch (error) {
      if (error instanceof ApiError) {
        if (
          [
            'standard_change_unconfirmed',
            'standard_required',
            'standard_invalid_template',
          ].includes(error.code)
        )
          return {
            ok: false,
            error: error.code as
              | 'standard_change_unconfirmed'
              | 'standard_required'
              | 'standard_invalid_template',
          }
        if (error.status === 409 && error.code === 'stale_plate') {
          return {
            ok: false,
            error: 'stale_plate',
            current: error.body.current as Plate,
            currentRevision: error.body.currentRevision as string,
            batchId: batchId!,
            draft: fields,
            ...(error.body.conflicts
              ? { conflicts: error.body.conflicts as PlateFieldConflicts }
              : {}),
          }
        }
        if (error.status === 409 && error.code === 'superseded_revision')
          return { ok: false, error: 'superseded_revision' }
        if (error.status === 403) return { ok: false, error: 'forbidden' }
        if (error.status === 404) return { ok: false, error: 'not_found' }
        if (error.status === 422) return { ok: false, error: 'invalid_state' }
      }
      throw error
    }
  }

  /**
   * Queue a plate edit behind earlier writes and keep pending state accurate when it
   * settles.
   */
  function edit(
    plate: PlateCardData | OverlaidPlate,
    fields: EditableFields,
    reviewed?: {
      batchId: string
      baseRevision: string
      standard?: StandardChange
    },
    standard?: StandardChange
  ): Promise<EditResult<Plate>> {
    setPendingCount((count) => count + 1)
    const result = parallel
      ? save(plate, fields, reviewed, standard)
      : queue.current.then(() => save(plate, fields, reviewed, standard))
    queue.current = result.catch(() => undefined)
    return result.finally(() => setPendingCount((count) => count - 1))
  }

  return { edit, pending: pendingCount > 0 }
}

export type MoveOrigin = { batchId: string | null; revision: number | null }

/**
 * Expose ordering and family edits together with revision capture and shared pending
 * state.
 */
export function useReorderState() {
  const { api } = useSession()
  const { cache, mutate } = useSWRConfig()
  const ensureBatch = useEnsureBatch()
  const workspace = useWorkspaceBatch()
  const draftId = useSharedDraftId()
  const personalId = workspace.mode === 'personal' ? draftId : null
  const personal = useBatch(personalId, { reuse: true })
  const displayed =
    workspace.mode === 'selected' ? workspace.detail : personal.data
  // Let the dashboard finish loading its draft before enabling drag.
  const ready =
    workspace.mode === 'selected'
      ? workspace.status === 'ready'
      : !!personalId && personal.data?.batch.id === personalId
  const [pendingCount, setPendingCount] = useState(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  async function refreshMovedBatch(key: string, revision?: number) {
    let saved = await fetchBatchDetail(api, key)
    if (revision !== undefined && saved.batch.revision < revision)
      saved = await fetchBatchDetail(api, key)
    const cached = await mutate<BatchDetail>(
      key,
      (detail) => preferCurrentBatch(detail, saved),
      { revalidate: false }
    )
    return cached ?? saved
  }

  /** Apply an anchored move and refresh the saved order after the request. */
  async function save(
    state: string,
    moves: StateMove[],
    standard?: StandardChange,
    preview?: string[],
    origin?: MoveOrigin
  ): Promise<
    { ok: true; detail: BatchDetail } | Extract<EditResult, { ok: false }>
  > {
    if (!moves.length) return { ok: false, error: 'invalid_state' }
    let key: string | undefined
    try {
      if (workspace.mode === 'selected' && workspace.status !== 'ready')
        return {
          ok: false,
          error: workspace.status === 'unavailable' ? 'not_found' : 'forbidden',
        }
      if (
        workspace.mode === 'selected' &&
        origin &&
        origin.batchId !== workspace.id
      )
        return { ok: false, error: 'not_found' }
      const id =
        origin?.batchId ??
        (workspace.mode === 'selected' ? workspace.id : await ensureBatch())
      key = batchApiPath(id)
      const detail =
        (cache.get(key)?.data as BatchDetail | undefined) ??
        (await fetchBatchDetail(api, key))
      const requestKey = key
      const saved = await mutate<BatchDetail>(
        key,
        async () => {
          const batch = await api.send<ReviewBatch>(
            'PUT',
            `${requestKey}/state-order/${encodeURIComponent(state)}`,
            { moves, ...(standard && { standard }) }
          )
          return { ...detail, batch }
        },
        {
          ...(preview && {
            optimisticData: {
              ...detail,
              batch: {
                ...detail.batch,
                stateOrders: { ...detail.batch.stateOrders, [state]: preview },
              },
            },
          }),
          rollbackOnError: true,
          revalidate: false,
        }
      )
      const confirmed = await refreshMovedBatch(key, saved?.batch.revision)
      await mutate(
        (key) =>
          typeof key === 'string' &&
          (key === batchesKey() || key.startsWith(`${batchesKey()}?`))
      )
      return { ok: true, detail: confirmed }
    } catch (error) {
      if (error instanceof ApiError) {
        if (
          error.code === 'standard_change_unconfirmed' ||
          error.code === 'standard_required' ||
          error.code === 'standard_invalid_template'
        )
          return { ok: false, error: error.code }
        const message = apiErrorReasons(error)[0]
        if (error.status === 409) {
          if (key) await refreshMovedBatch(key).catch(() => undefined)
          return {
            ok: false,
            error: 'superseded_revision',
            ...(message && { message }),
          }
        }
        if (error.status === 403) return { ok: false, error: 'forbidden' }
        if (error.status === 404) return { ok: false, error: 'not_found' }
        if (error.status === 422)
          return {
            ok: false,
            error: 'invalid_state',
            ...(message && { message }),
          }
      }
      if (key) await refreshMovedBatch(key).catch(() => undefined)
      throw error
    }
  }

  /** Serialize placement requests from this dashboard. */
  function reorder(
    state: string,
    order: string[],
    standard: StandardChange | undefined,
    moves: StateMove[]
  ): Promise<EditResult> {
    setPendingCount((count) => count + 1)
    const result = queue.current.then(async (): Promise<EditResult> => {
      const saved = await save(state, moves, standard, order)
      if (!saved.ok) return saved
      return {
        ok: true,
        revisions: Object.fromEntries(
          saved.detail.plates.map((entry) => [
            entry.proposed.id,
            entry.revision,
          ])
        ),
      }
    })
    queue.current = result.catch(() => undefined)
    return result.finally(() => setPendingCount((count) => count - 1))
  }

  /** Remember which draft was open when the drag started. */
  function capture(): MoveOrigin {
    const id =
      workspace.mode === 'selected'
        ? workspace.id
        : (displayed?.batch.id ?? draftId ?? undefined)
    const batch = id
      ? ((cache.get(batchApiPath(id))?.data as BatchDetail | undefined)
          ?.batch ?? displayed?.batch)
      : undefined
    return { batchId: id ?? null, revision: batch?.revision ?? null }
  }

  /** Promote and place Variants in one save. */
  async function move(
    state: string,
    moves: StateMove[],
    origin: MoveOrigin,
    standard?: StandardChange
  ): Promise<EditResult> {
    setPendingCount((count) => count + 1)
    try {
      const saved = await save(state, moves, standard, undefined, origin)
      if (!saved.ok) return saved
      const ids = moves.flatMap(({ plateIds }) => plateIds)
      const entries = new Map(
        saved.detail.plates.map((entry) => [entry.proposed.id, entry])
      )
      const plate = entries.get(ids[0])
      if (
        !plate ||
        ids.some((id) => {
          const proposed = entries.get(id)?.proposed
          return (
            proposed?.templateRole !== 'template' ||
            proposed.variantOfPlateId != null
          )
        })
      )
        return {
          ok: false,
          error: 'superseded_revision',
          message: 'Reload the draft to see the current templates.',
        }
      return {
        ok: true,
        proposed: plate.proposed,
        revision: plate.revision,
        revisions: Object.fromEntries(
          saved.detail.plates.map((entry) => [
            entry.proposed.id,
            entry.revision,
          ])
        ),
        batchId: saved.detail.batch.id,
      }
    } finally {
      setPendingCount((count) => count - 1)
    }
  }

  /** Join selected plates to the current destination family. */
  async function merge(
    input: FamilyMerge,
    origin: MoveOrigin,
    standard?: StandardChange
  ): Promise<
    { ok: true; value: FamilyMergeResult } | { ok: false; message: string }
  > {
    setPendingCount((count) => count + 1)
    try {
      if (
        workspace.mode === 'selected' &&
        (workspace.status !== 'ready' || origin.batchId !== workspace.id)
      ) {
        return {
          ok: false,
          message: 'The selected Batch is unavailable for editing.',
        }
      }
      const key = batchApiPath(origin.batchId ?? (await ensureBatch()))
      const { revision, ...value } = await api.send<
        FamilyMergeResult & { revision: number }
      >('POST', `${key}/family-merge`, {
        destinationId: input.destination.id,
        plateIds: input.members.map(({ id }) => id),
        ...(standard && { standard }),
      })
      if (value.moved.length) await refreshMovedBatch(key, revision)
      return { ok: true, value }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      const [reason] = apiErrorReasons(error)
      const message =
        reason ??
        (error.code === 'superseded_revision'
          ? 'Drag again using the latest families.'
          : error.code === 'standard_change_unconfirmed'
            ? 'The move would change the Standard. Review the new Standard before saving.'
            : error.code === 'pipeline_busy'
              ? PIPELINE_BUSY_MESSAGE
              : 'This family move could not be saved.')
      return { ok: false, message }
    } finally {
      setPendingCount((count) => count - 1)
    }
  }

  function orderBaseline(
    state: string,
    cards: readonly Pick<
      PlateCardData,
      'id' | 'displayName' | 'sortOrder' | 'isStandard' | 'deleted'
    >[]
  ) {
    const stateCards = cards.filter((card) => card.id.startsWith(state + '.'))
    if (!stateCards.length) return
    const proposedById = new Map(
      displayed?.plates.map((entry) => [entry.proposed.id, entry.proposed])
    )
    const first =
      displayed?.batch.stateOrders[state]?.[0] ??
      stateCards.sort(
        (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)
      )[0].id
    return {
      first,
      plates: stateCards.map((card) => {
        const proposed = proposedById.get(card.id)
        return {
          id: card.id,
          displayName: card.displayName,
          state,
          isStandard: proposed ? proposed.isStandard : card.isStandard,
          deleted: proposed ? proposed.deleted : card.deleted,
        }
      }),
    }
  }

  return {
    reorder,
    capture,
    move,
    merge,
    orderBaseline,
    stateOrders: displayed?.batch.stateOrders,
    batch: displayed?.batch,
    pending: pendingCount > 0,
    ready,
  }
}

/** Cache the model list so tagging controls share the same server configuration. */
export function useTaggingModels() {
  const { user, api } = useSession()
  return useSWR<import('./tagging-models').TaggingModels>(
    user ? '/api/tagging/models' : null,
    api.get
  )
}
