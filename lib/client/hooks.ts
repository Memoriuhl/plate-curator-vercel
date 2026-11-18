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
import type {
  Actor,
  BatchState,
  DraftChangeTarget,
  EditableFields,
  ProposedEdit,
  ReviewBatch,
  StandardChange,
} from '../review/types'
import type { FamilyMerge } from '../review/family-merge'
import type { FamilyMergeResult } from '../review/family-merge-plan'
import { sameEditableValue } from '../review/story'
import { canEdit, editableStates } from '../review/access'
import { mostRecentBatch } from '../review/batch-selection'
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

/** Fetch the signed-in user's current membership and environment. */
export function useMe(enabled = true) {
  const { user, api } = useSession()
  // Share membership across session consumers and reuse it on remount when cached.
  return useSWR<Actor>(user && enabled ? '/api/me' : null, api.get, {
    revalidateIfStale: false,
    dedupingInterval: 30000,
  })
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

/**
 * Cache the assembled batch by ID. Editing views can reuse it on mount because
 * mutations and live revision signals refresh the shared entry.
 */
export function useBatch(id: string | null, opts?: { reuse?: boolean }) {
  const { user, api } = useSession()
  return useSWR<BatchDetail>(
    user && id ? batchApiPath(id) : null,
    (key) => fetchBatchDetail(api, key),
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
            'The Catalog changed since review. Copy to a new Batch for fresh review.',
          [BASELINE_ERRORS.receiptConflict]:
            'The interrupted Publish used an unreviewed baseline. Copy for fresh review or investigate the receipt.',
          ...PUBLISH_STOP_MESSAGES,
          [PIPELINE_BUSY]: PIPELINE_BUSY_MESSAGE,
          empty_batch: 'This Batch has no changes to publish.',
          standard_change_unconfirmed:
            apiErrorReasons(error).join(' ') ||
            'Resolve the Standard plate changes before publishing.',
          publish_disabled_here: 'Publishing is disabled in this environment.',
          superseded_revision:
            'This Batch changed. Confirm the current revision.',
          [PUBLISH_ERRORS.notWaiting]:
            'This run is no longer waiting for Publish. Refresh to see its status.',
          forbidden: 'Only the Owner can Publish.',
          not_found: 'This Batch could not be found.',
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
    /** Copy the batch to the current baseline and refresh the batch list. */
    async copy(batchId: string, revision: number, targetVersion: number) {
      const batch = await api.send<ReviewBatch & { warnings?: string[] }>(
        'POST',
        `${batchApiPath(batchId)}/copy`,
        { revision, targetVersion }
      )
      await refresh().catch(() => undefined)
      return batch
    },
    /** Create a review batch and refresh the lists that can show it. */
    async create(name: string, plateIds: string[]) {
      const batch = await api.send<ReviewBatch>('POST', '/api/batches', {
        name,
        plateIds,
      })
      await refresh()
      return batch
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
    /** Submit the batch at its current revision and refresh its review state. */
    async submit(batchId: string, revision: number) {
      const batch = await api.send<ReviewBatch>(
        'POST',
        `${batchApiPath(batchId)}/submit`,
        { revision }
      )
      await refresh(batchId)
      return batch
    },
    /** Approve the batch at its current revision and reload its updated status. */
    async approve(batchId: string, revision: number) {
      const batch = await api.send<ReviewBatch>(
        'POST',
        `${batchApiPath(batchId)}/approve`,
        { revision }
      )
      await refresh(batchId)
      return batch
    },
  }
}

export type OverlaidPlate = PlateCardData &
  StoryFields & { changedInBatch: boolean }

/** Read the active batch selection from the current URL. */
export function useSelectedBatchId() {
  return useSearchParams()?.get('batch') ?? null
}

/** Resolve the URL's batch and its editability for the workspace. */
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
        : canEdit(detail.data.batch, me.data) &&
            editableStates.includes(detail.data.batch.state)
          ? 'ready'
          : 'read-only'
  return { mode: 'selected' as const, id, detail: detail.data, status }
}

/**
 * Overlay the selected or most recent batch's draft fields and ordering on the catalog
 * plates.
 */
export function useDraftOverlay(plates: PlateCardData[]): OverlaidPlate[] {
  const { data: batches } = useBatches(['open'], { mine: true })
  const workspace = useWorkspaceBatch()
  const personal = useBatch(
    workspace.mode === 'personal'
      ? (mostRecentBatch(batches)?.id ?? null)
      : null,
    { reuse: true }
  )
  const detail =
    workspace.mode === 'selected' ? workspace.detail : personal.data
  // Reuse projected cards and checks until the catalog plates or batch details change.
  return useMemo(() => {
    const entries = new Map(
      detail?.plates.map((entry) => [entry.proposed.id, entry])
    )
    const positions = new Map(
      Object.entries(detail?.batch.stateOrders ?? {}).map(([state, order]) => [
        state,
        new Map(order.map((id, index) => [id, index])),
      ])
    )
    return plates.map((card) => {
      const entry = entries.get(card.id)
      const position = positions.get(card.state)?.get(card.id) ?? -1
      const ordered = position >= 0 ? { ...card, sortOrder: position } : card
      const reordered = position >= 0 && position !== card.sortOrder
      if (!entry) return { ...ordered, changedInBatch: reordered }
      const { proposed } = entry
      const imageUrl = entry.edit?.fields.imageUrl ?? card.imageUrl
      const checks = plateChecks(proposed, imageUrl)
      return {
        ...ordered,
        imageUrl,
        deleted: proposed.deleted === true,
        tags: proposed.tags,
        templateFamily: proposed.templateFamily ?? null,
        templateRole: familyRole(proposed),
        variantOfPlateId: proposed.variantOfPlateId ?? null,
        isStandard: proposed.isStandard ?? false,
        revision: entry.revision,
        checks,
        funFacts: proposed.funFacts ?? [],
        readMore: proposed.readMore ?? [],
        wikiUrl: proposed.wikiUrl ?? null,
        ...('firstIssuedYear' in card
          ? { firstIssuedYear: proposed.firstIssuedYear ?? null }
          : {}),
        complete: isComplete(checks),
        changedInBatch: entry.edit !== null || reordered,
        ...(detail &&
        Object.entries(entry.edit?.pipelineChanges ?? {}).some(
          ([field, change]) =>
            sameEditableValue(field, change.value, proposed[field]) &&
            !sameEditableValue(field, entry.baseline[field], proposed[field])
        )
          ? { pipelineBatchId: detail.batch.id }
          : {}),
      }
    })
  }, [plates, detail])
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

// Share one pending lookup or creation per SWR provider and user to avoid duplicate drafts.
const batchCreations = new WeakMap<object, Map<string, Promise<string>>>()

/**
 * Reuse an editable batch or share one in-flight creation for concurrent edits in the
 * same workspace.
 */
export function useEnsureBatch(): (plate: {
  id: string
  state: string
}) => Promise<string> {
  const { user, api } = useSession()
  const { cache, mutate } = useSWRConfig()
  const { data: batches } = useBatches(['open'], { mine: true })
  return (plate) => {
    if (!user) return Promise.reject(new ApiError(401, 'unauthenticated', {}))
    let creations = batchCreations.get(cache)
    if (!creations) {
      creations = new Map()
      batchCreations.set(cache, creations)
    }
    const existing = creations.get(user.uid)
    if (existing) return existing
    const creation = (async () => {
      const key = batchesKey(['open'], { mine: true })
      const current =
        (cache.get(key)?.data as ReviewBatch[] | undefined) ??
        batches ??
        (await api.get<ReviewBatch[]>(key))
      const batch = mostRecentBatch(current)
      if (batch) return batch.id
      const created = await api.send<ReviewBatch>('POST', batchesKey(), {
        name: `${plate.state} edits`,
        plateIds: [plate.id],
      })
      // Cache the returned batch so the next edit can find it without refetching the list.
      await mutate(key, [created, ...current], { revalidate: false })
      return created.id
    })().finally(() => creations.delete(user.uid))
    creations.set(user.uid, creation)
    return creation
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
      const baseRevision =
        reviewed?.baseRevision ??
        (workspace.mode === 'selected'
          ? plate.revision
          : (detail.plates.find((entry) => entry.proposed.id === plate.id)
              ?.revision ?? plate.revision))
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
  const { data: personalBatches } = useBatches(['open'], { mine: true })
  const personalId =
    workspace.mode === 'personal'
      ? (mostRecentBatch(personalBatches)?.id ?? null)
      : null
  const personal = useBatch(personalId, { reuse: true })
  const displayed =
    workspace.mode === 'selected' ? workspace.detail : personal.data
  const ready =
    workspace.mode === 'selected'
      ? workspace.status === 'ready'
      : !!personalBatches &&
        (!personalId || personal.data?.batch.id === personalId)
  const [pendingCount, setPendingCount] = useState(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  async function refreshMovedBatch(key: string, revision?: number) {
    let saved = await fetchBatchDetail(api, key)
    if (revision !== undefined && saved.batch.revision < revision)
      saved = await fetchBatchDetail(api, key)
    const cached = await mutate<BatchDetail>(
      key,
      (detail) =>
        detail && detail.batch.revision > saved.batch.revision ? detail : saved,
      { revalidate: false }
    )
    return cached ?? saved
  }

  /** Save a state order at its reviewed revision and reload on conflicts. */
  async function save(
    state: string,
    order: string[],
    standard?: StandardChange
  ): Promise<EditResult> {
    if (!order.length) return { ok: false, error: 'invalid_state' }
    try {
      if (workspace.mode === 'selected' && workspace.status !== 'ready')
        return {
          ok: false,
          error: workspace.status === 'unavailable' ? 'not_found' : 'forbidden',
        }
      const id =
        workspace.mode === 'selected'
          ? workspace.id
          : await ensureBatch({ id: order[0], state })
      const key = batchApiPath(id)
      // Reuse the visible revision for the order write when detail is already cached.
      const detail =
        (cache.get(key)?.data as BatchDetail | undefined) ??
        (await fetchBatchDetail(api, key))
      // Show the proposed order in SWR immediately and restore the entry if the save fails.
      await mutate(
        key,
        async () => {
          const batch = await api.send<ReviewBatch>(
            'PUT',
            `${key}/state-order/${encodeURIComponent(state)}`,
            {
              batchRevision: detail.batch.revision,
              order,
              ...(standard ? { standard } : {}),
            }
          )
          return { ...detail, batch }
        },
        {
          optimisticData: {
            ...detail,
            batch: {
              ...detail.batch,
              stateOrders: { ...detail.batch.stateOrders, [state]: order },
            },
          },
          rollbackOnError: true,
          revalidate: false,
        }
      )
      const saved = await mutate<BatchDetail>(key, fetchBatchDetail(api, key), {
        revalidate: false,
      })
      await mutate(
        (key) =>
          typeof key === 'string' &&
          (key === batchesKey() || key.startsWith(`${batchesKey()}?`))
      )
      return {
        ok: true,
        revisions: Object.fromEntries(
          saved?.plates.map((entry) => [entry.proposed.id, entry.revision]) ??
            []
        ),
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
        if (error.status === 409 && error.code === 'superseded_revision')
          return { ok: false, error: 'superseded_revision' }
        if (error.status === 403) return { ok: false, error: 'forbidden' }
        if (error.status === 404) return { ok: false, error: 'not_found' }
        if (error.status === 422) return { ok: false, error: 'invalid_state' }
      }
      throw error
    }
  }

  /** Serialize reorder requests so overlapping drag actions reach the server in order. */
  function reorder(
    state: string,
    order: string[],
    standard?: StandardChange
  ): Promise<EditResult> {
    setPendingCount((count) => count + 1)
    const proposed = [...order]
    const result = queue.current.then(() => save(state, proposed, standard))
    queue.current = result.catch(() => undefined)
    return result.finally(() => setPendingCount((count) => count - 1))
  }

  /** Capture the visible SWR revision so a drag saves against its starting batch. */
  function capture(): MoveOrigin {
    const cachedBatches = cache.get(batchesKey(['open'], { mine: true }))
      ?.data as ReviewBatch[] | undefined
    const id =
      workspace.mode === 'selected'
        ? workspace.id
        : (displayed?.batch.id ?? mostRecentBatch(cachedBatches)?.id)
    const batch = id
      ? ((cache.get(batchApiPath(id))?.data as BatchDetail | undefined)
          ?.batch ?? displayed?.batch)
      : undefined
    return { batchId: id ?? null, revision: batch?.revision ?? null }
  }

  /**
   * Move a plate in the current state order and reconcile any required standard-plate
   * change.
   */
  async function move(
    state: string,
    order: string[],
    promotion:
      | { plateId: string; templateFamily: string }
      | { plateId: string; templateFamily: string }[],
    origin: MoveOrigin,
    standard?: StandardChange
  ): Promise<EditResult> {
    setPendingCount((count) => count + 1)
    let key: string | undefined
    const promotions = Array.isArray(promotion) ? promotion : [promotion]
    const firstPromotion = promotions[0]
    if (!firstPromotion) {
      setPendingCount((count) => count - 1)
      return { ok: false, error: 'invalid_state' }
    }
    function confirmed(saved: BatchDetail): EditResult | undefined {
      const savedOrder = saved.batch.stateOrders[state]
      if (
        savedOrder?.length !== order.length ||
        savedOrder.some((id, index) => id !== order[index])
      )
        return
      const entries = new Map(
        saved.plates.map((entry) => [entry.proposed.id, entry])
      )
      if (
        !promotions.every(({ plateId, templateFamily }) => {
          const plate = entries.get(plateId)?.proposed
          return (
            plate?.templateRole === 'template' &&
            plate.variantOfPlateId == null &&
            plate.templateFamily === templateFamily
          )
        })
      )
        return
      const entry = entries.get(firstPromotion.plateId)!
      return {
        ok: true,
        proposed: entry.proposed,
        revision: entry.revision,
        revisions: Object.fromEntries(
          saved.plates.map((entry) => [entry.proposed.id, entry.revision])
        ),
        batchId: saved.batch.id,
      }
    }
    try {
      if (
        workspace.mode === 'selected' &&
        (workspace.status !== 'ready' || origin.batchId !== workspace.id)
      )
        return { ok: false, error: 'not_found' }
      if (origin.batchId && origin.revision === null)
        return { ok: false, error: 'superseded_revision' }
      const id =
        origin.batchId ??
        (await ensureBatch({ id: firstPromotion.plateId, state }))
      key = batchApiPath(id)
      const savedBatch = await api.send<ReviewBatch>(
        'PUT',
        key + '/state-order/' + encodeURIComponent(state),
        {
          batchRevision: origin.revision ?? 0,
          order,
          ...(Array.isArray(promotion) ? { promotions } : { promotion }),
          ...(standard ? { standard } : {}),
        }
      )
      const current = await refreshMovedBatch(key, savedBatch.revision)
      await mutate(
        (key) =>
          typeof key === 'string' &&
          (key === batchesKey() || key.startsWith(batchesKey() + '?'))
      )
      return (
        confirmed(current) ?? {
          ok: false,
          error: 'superseded_revision',
          message:
            'The saved Batch did not contain this template move. Try again from the current order.',
        }
      )
    } catch (error) {
      if (key) {
        const saved = await refreshMovedBatch(key)
        if (!(error instanceof ApiError)) {
          const result = confirmed(saved)
          if (result) return result
        }
      }
      if (error instanceof ApiError) {
        const message = apiErrorReasons(error)[0]
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
        if (error.status === 409)
          return {
            ok: false,
            error: 'superseded_revision',
            ...(message && { message }),
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
      throw error
    } finally {
      setPendingCount((count) => count - 1)
    }
  }

  /** Commit a family merge and refresh the affected state and batch after the request. */
  async function merge(
    input: FamilyMerge,
    origin: MoveOrigin
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
      if (origin.batchId && origin.revision === null)
        return {
          ok: false,
          message: 'Wait for the Batch to load, then drag again.',
        }
      const id =
        origin.batchId ??
        (await ensureBatch({
          id: input.members[0].id,
          state: input.destination.id.split('.')[0],
        }))
      const key = batchApiPath(id)
      const value = await api.send<FamilyMergeResult>(
        'POST',
        `${key}/family-merge`,
        { ...input, batchRevision: origin.revision ?? 0 }
      )
      if (value.moved.length) {
        const saved = await refreshMovedBatch(key, (origin.revision ?? 0) + 1)
        const parents = new Map(
          saved.plates.map((entry) => [
            entry.proposed.id,
            entry.proposed.variantOfPlateId,
          ])
        )
        if (
          value.moved.some(
            (plateId) => parents.get(plateId) !== input.destination.id
          )
        ) {
          return {
            ok: false,
            message:
              'The saved Batch did not contain this family move. Drag again from the current families.',
          }
        }
      }
      return { ok: true, value }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      const [reason] = apiErrorReasons(error)
      const message =
        reason ??
        (error.code === 'superseded_revision'
          ? 'The Batch changed. Drag again using the latest selection.'
          : error.code === 'pipeline_busy'
            ? PIPELINE_BUSY_MESSAGE
            : error.status === 403
              ? 'Only the Batch creator or an Owner can move plates.'
              : 'This family move could not be saved.')
      return { ok: false, message }
    } finally {
      setPendingCount((count) => count - 1)
    }
  }

  return {
    reorder,
    capture,
    move,
    merge,
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
