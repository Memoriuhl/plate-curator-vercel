'use client'

import type { RunStatus } from '../review/run-status'

import { PUBLISH_ERRORS, PUBLISH_STOP_MESSAGES } from '../publish/stop'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import type { PlateCardData, PlateDetail } from '../catalog/dashboard-types'
import { isComplete, plateChecks } from '../catalog/plate-checks'
import useSWR, { preload, useSWRConfig } from 'swr'
import type { Plate } from '../catalog/types'
import type { Actor, BatchState, EditableFields, ProposedEdit, ReviewBatch } from '../review/types'
import { canEdit, editableStates } from '../review/access'
import { BASELINE_ERRORS, type BaselineError } from '../publish/baseline'
import type { Abandonment, PublishControlState, PublishStop, RequesterAuthority } from '../publish/types'
import { ApiError } from './api'
import { useSession } from './session'
import type { MemberInvite, MemberSummary } from '../members/summary'

export type BatchDetail = {
  batch: ReviewBatch
  plates: { beforeImageUrl?: string | null; afterImageUrl?: string | null; baseline: Plate; proposed: Plate; edit: ProposedEdit | null; revision: string; order?: { before: number; after: number; total: number } }[]
}

export function batchesKey(states?: BatchState[], opts?: { mine?: boolean }) {
  const params = []
  if (states?.length) params.push(`state=${states.join(',')}`)
  if (opts?.mine) params.push('mine=1')
  return `/api/batches${params.length ? `?${params.join('&')}` : ''}`
}

export function useMe(enabled = true) {
  const { user, api } = useSession()
  return useSWR<Actor>(user && enabled ? '/api/me' : null, api.get, { revalidateIfStale: false, dedupingInterval: 30000 })
}

export function useMembers() {
  const { user, api } = useSession()
  const me = useMe()
  return useSWR<MemberSummary[]>(user && me.data?.role === 'owner' ? '/api/members' : null, api.get)
}

export function useInviteMember() {
  const { api } = useSession()
  const { mutate } = useSWRConfig()
  return async (email: string, role: MemberSummary['role']) => {
    const result = await api.send<MemberInvite>('POST', '/api/members', { email, role })
    await mutate('/api/members').catch(() => undefined)
    return result
  }
}

export function useBatches(states?: BatchState[], opts?: { mine?: boolean }) {
  const { user, api } = useSession()
  return useSWR<ReviewBatch[]>(user ? batchesKey(states, opts) : null, api.get, states?.length === 1 && states[0] === 'open' && opts?.mine
    ? { revalidateIfStale: false, dedupingInterval: 30000 }
    : undefined)
}

export function useBatch(id: string | null, opts?: { reuse?: boolean }) {
  const { user, api } = useSession()
  return useSWR<BatchDetail>(user && id ? `/api/batches/${id}` : null, api.get, opts?.reuse
    ? { revalidateIfStale: false }
    : undefined)
}

export type BatchRun = RunStatus

const publishWindows = new Map<string, number>()

export function useBatchRun(id: string | null) {
  const router = useRouter()
  const previousRun = useRef<{ id: string | null; phase: BatchRun['phase'] | undefined }>({ id: null, phase: undefined })
  const { user, api } = useSession()
  const me = useMe()
  const { mutate } = useSWRConfig()
  const [pendingUntil, setPendingUntil] = useState(0)
  useEffect(() => {
    const update = () => setPendingUntil(publishWindows.get(id ?? '') ?? 0)
    update()
    window.addEventListener('batch-publish-requested', update)
    return () => window.removeEventListener('batch-publish-requested', update)
  }, [id])
  const run = useSWR<BatchRun>(user && me.data?.role === 'owner' && id ? `/api/batches/${id}/run` : null, api.get, {
    refreshInterval: data => data?.phase === 'publishing' || (data?.phase === 'waiting-for-publish' && pendingUntil > Date.now()) ? 2000 : 0,
  })
  useEffect(() => {
    const phase = run.data?.phase
    const previous = previousRun.current
    previousRun.current = { id, phase }
    if (id && previous.id === id && previous.phase != null && previous.phase !== 'published' && phase === 'published') router.refresh()
    if (id && run.data?.phase && ['published', 'failed', 'superseded', 'timed-out'].includes(run.data.phase)) {
      publishWindows.delete(id)
      void mutate(key => typeof key === 'string' && (key === '/api/batches' || key.startsWith('/api/batches?') || key === `/api/batches/${id}`)).catch(() => undefined)
    }
  }, [id, run.data?.phase, mutate, router])
  return run
}

export const plateDetailKey = (id: string) => `/api/plates/${id}`

export function usePlateDetail(id: string | null) {
  const { user, api } = useSession()
  return useSWR<PlateDetail>(user && id ? plateDetailKey(id) : null, api.get)
}

export function usePreloadPlateDetail() {
  const { user, api } = useSession()
  return (id: string) => {
    if (user) preload(plateDetailKey(id), api.get).catch(() => undefined)
  }
}

export type PublishBaselineStatus = { canAbandon?: boolean; abandonReason?: string | null; prepared?: { commandId: string; toVersion: number }; abandonment?: Abandonment; canRetry?: boolean; retryReason?: string | null; stopped?: { reason: PublishStop; requestedBy?: RequesterAuthority } } & (
  | { error: BaselineError | null; reviewedVersion: number; liveVersion: number }
  | { error: PublishStop; reviewedVersion?: never; liveVersion?: never }
)

export function usePublishControl() {
  const { user, api } = useSession()
  const { mutate } = useSWRConfig()
  const status = useSWR<{ control: PublishControlState | null }>(user ? '/api/publish/control' : null, api.get, { refreshInterval: 30000 })
  return { ...status, async change(paused: boolean) {
    const result = await api.send<{ control: PublishControlState }>('POST', '/api/publish/control', { paused })
    await status.mutate(result, { revalidate: false })
    await mutate(key => typeof key === 'string' && key.startsWith('/api/batches/') && key.endsWith('/publish')).catch(() => undefined)
  } }
}

export function usePublishBaseline(id: string) {
  const { user, api } = useSession()
  return useSWR<PublishBaselineStatus>(user ? `/api/batches/${id}/publish` : null, api.get)
}

export function useReviewActions() {
  const { api } = useSession()
  const { mutate } = useSWRConfig()
  const publishIntents = useRef(new Map<string, string>())
  const refresh = (batchId?: string) => mutate((key) => typeof key === 'string' && (key.startsWith('/api/batches?') || key === '/api/batches' || key === `/api/batches/${batchId}`))

  return {
    async abandon(batchId: string, revision: number, commandId: string, reason: string) {
      try {
        await api.send('POST', `/api/batches/${batchId}/abandon`, { revision, commandId, reason })
      } finally {
        await Promise.all([refresh(batchId), mutate(`/api/batches/${batchId}/publish`)]).catch(() => undefined)
      }
    },
    async publish(batchId: string, revision: number): Promise<{ ok: true } | { ok: false; message: string; reviewedVersion?: number; liveVersion?: number }> {
      const key = `${batchId}@${revision}`
      const commandId = publishIntents.current.get(key) ?? crypto.randomUUID()
      publishIntents.current.set(key, commandId)
      try {
        await api.send<{ status: 'publishing' }>('POST', `/api/batches/${batchId}/publish`, { revision, commandId })
        publishIntents.current.delete(key)
        publishWindows.set(batchId, Date.now() + 30000)
        window.dispatchEvent(new Event('batch-publish-requested'))
        await Promise.all([refresh(batchId), mutate(`/api/batches/${batchId}/run`), mutate(`/api/batches/${batchId}/publish`)]).catch(() => undefined)
        return { ok: true }
      } catch (error) {
        if (error instanceof ApiError && error.status < 500) publishIntents.current.delete(key)
        const messages: Record<string, string> = {
          [BASELINE_ERRORS.stale]: 'The Catalog changed since review. Copy to a new Batch for fresh review.',
          [BASELINE_ERRORS.receiptConflict]: 'The interrupted Publish used an unreviewed baseline. Copy for fresh review or investigate the receipt.',
          ...PUBLISH_STOP_MESSAGES,
          publish_disabled_here: 'Publishing is disabled in this environment.',
          superseded_revision: 'This Batch changed since approval and must be re-approved.',
          [PUBLISH_ERRORS.notWaiting]: 'This run is no longer waiting for Publish. Refresh to see its status.',
          forbidden: 'Only the Owner can Publish.',
          not_found: 'This Batch could not be found.',
        }
        await Promise.all([refresh(batchId), mutate(`/api/batches/${batchId}/run`), mutate(`/api/batches/${batchId}/publish`)]).catch(() => undefined)
        return { ok: false, ...(error instanceof ApiError && typeof error.body.liveVersion === 'number' ? { reviewedVersion: error.body.reviewedVersion as number, liveVersion: error.body.liveVersion } : {}), message: error instanceof ApiError ? messages[error.code] ?? 'Could not Publish. Please try again.' : 'Could not Publish. Please try again.' }
      }
    },
    async copy(batchId: string, revision: number, targetVersion: number) {
      const batch = await api.send<ReviewBatch>('POST', `/api/batches/${batchId}/copy`, { revision, targetVersion })
      await refresh().catch(() => undefined)
      return batch
    },
    async create(name: string, plateIds: string[]) {
      const batch = await api.send<ReviewBatch>('POST', '/api/batches', { name, plateIds })
      await refresh()
      return batch
    },
    async propose(batchId: string, plateId: string, baseRevision: string, fields: EditableFields) {
      const result = await api.send<{ batch: ReviewBatch; plate: Plate }>('PATCH', `/api/batches/${batchId}/plates/${plateId}`, { baseRevision, fields })
      await refresh(batchId)
      return result
    },
    async submit(batchId: string, revision: number) {
      const batch = await api.send<ReviewBatch>('POST', `/api/batches/${batchId}/submit`, { revision })
      await refresh(batchId)
      return batch
    },
    async approve(batchId: string, revision: number) {
      const batch = await api.send<ReviewBatch>('POST', `/api/batches/${batchId}/approve`, { revision })
      await refresh(batchId)
      return batch
    },
  }
}

export type OverlaidPlate = PlateCardData & { changedInBatch: boolean }

function mostRecentBatch(batches: ReviewBatch[] | undefined): ReviewBatch | undefined {
  const updated = (batch: ReviewBatch) => (batch as ReviewBatch & { updatedAt?: string }).updatedAt ?? batch.createdAt
  return batches?.reduce<ReviewBatch | undefined>((latest, batch) => !latest || updated(batch) > updated(latest) ? batch : latest, undefined)
}

export function useSelectedBatchId() {
  return useSearchParams()?.get('batch') ?? null
}

export function useWorkspaceBatch() {
  const id = useSelectedBatchId()
  const detail = useBatch(id, { reuse: true })
  const me = useMe(id !== null)
  if (id === null) return { mode: 'personal' as const }
  const status = id === '' || detail.error || me.error ? 'unavailable' : !detail.data || !me.data ? 'loading' :
    canEdit(detail.data.batch, me.data) && editableStates.includes(detail.data.batch.state) ? 'ready' : 'read-only'
  return { mode: 'selected' as const, id, detail: detail.data, status }
}

export function useDraftOverlay(plates: PlateCardData[]): OverlaidPlate[] {
  const { data: batches } = useBatches(['open'], { mine: true })
  const workspace = useWorkspaceBatch()
  const personal = useBatch(workspace.mode === 'personal' ? mostRecentBatch(batches)?.id ?? null : null, { reuse: true })
  const detail = workspace.mode === 'selected' ? workspace.detail : personal.data
  return useMemo(() => {
    const entries = new Map(detail?.plates.map(entry => [entry.proposed.id, entry]))
    const positions = new Map(Object.entries(detail?.batch.stateOrders ?? {}).map(([state, order]) =>
      [state, new Map(order.map((id, index) => [id, index]))],
    ))
    return plates.map(card => {
      const entry = entries.get(card.id)
      const position = positions.get(card.state)?.get(card.id) ?? -1
      const ordered = position >= 0 ? { ...card, sortOrder: position } : card
      const reordered = position >= 0 && position !== card.sortOrder
      if (!entry) return { ...ordered, changedInBatch: reordered }
      const { proposed } = entry
      const checks = plateChecks(proposed, card.imageUrl)
      return {
        ...ordered, deleted: proposed.deleted === true, tags: proposed.tags, templateFamily: proposed.templateFamily ?? null,
        templateRole: proposed.templateRole ?? null, variantOfPlateId: proposed.variantOfPlateId ?? null,
        isStandard: proposed.isStandard ?? false, revision: entry.revision, checks,
        complete: isComplete(checks), changedInBatch: entry.edit !== null || reordered,
      }
    })
  }, [plates, detail])
}

export type EditResult<T = Plate | void> =
  | ({ ok: true } & (T extends void ? object : { proposed: T }))
  | { ok: false; error: 'stale_plate'; current: Plate; currentRevision: string; batchId: string; draft: EditableFields }
  | { ok: false; error: 'forbidden' | 'invalid_state' | 'not_found' | 'superseded_revision' }

const batchCreations = new WeakMap<object, Map<string, Promise<string>>>()

export function useEnsureBatch(): (plate: { id: string; state: string }) => Promise<string> {
  const { user, api } = useSession()
  const { cache, mutate } = useSWRConfig()
  const { data: batches } = useBatches(['open'], { mine: true })
  return plate => {
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
      const current = cache.get(key)?.data as ReviewBatch[] | undefined ?? batches ?? await api.get<ReviewBatch[]>(key)
      const batch = mostRecentBatch(current)
      if (batch) return batch.id
      const created = await api.send<ReviewBatch>('POST', batchesKey(), { name: `${plate.state} edits`, plateIds: [plate.id] })
      await mutate(key, [created, ...current], { revalidate: false })
      return created.id
    })().finally(() => creations.delete(user.uid))
    creations.set(user.uid, creation)
    return creation
  }
}

export function useEditPlate({ parallel = false }: { parallel?: boolean } = {}) {
  const { api } = useSession()
  const { cache, mutate } = useSWRConfig()
  const ensureBatch = useEnsureBatch()
  const workspace = useWorkspaceBatch()
  const [pendingCount, setPendingCount] = useState(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  async function save(plate: PlateCardData | OverlaidPlate, fields: EditableFields, reviewed?: { batchId: string; baseRevision: string }): Promise<EditResult<Plate>> {
    let batchId = reviewed?.batchId
    try {
      if (workspace.mode === 'selected' && workspace.status !== 'ready') return { ok: false, error: workspace.status === 'unavailable' ? 'not_found' : 'forbidden' }
      if (reviewed && workspace.mode === 'selected' && reviewed.batchId !== workspace.id) return { ok: false, error: 'not_found' }
      const id = reviewed?.batchId ?? (workspace.mode === 'selected' ? workspace.id : await ensureBatch(plate))
      batchId = id
      const key = `/api/batches/${id}`
      const detail = cache.get(key)?.data as BatchDetail | undefined ?? await api.get<BatchDetail>(key)
      const baseRevision = reviewed?.baseRevision ?? (workspace.mode === 'selected' ? plate.revision : detail.plates.find(entry => entry.proposed.id === plate.id)?.revision ?? plate.revision)
      if (!baseRevision) throw new Error('Cannot save a plate without a revision. Reload and try again.')
      const result = await api.send<{ batch: ReviewBatch; plate: Plate }>('PATCH', `${key}/plates/${plate.id}`, { baseRevision, fields })
      await mutate(key, api.get<BatchDetail>(key), { revalidate: false })
      await mutate(key => typeof key === 'string' && (key === batchesKey() || key.startsWith(`${batchesKey()}?`)))
      return { ok: true, proposed: result.plate }
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 409 && error.code === 'stale_plate') {
          return { ok: false, error: 'stale_plate', current: error.body.current as Plate, currentRevision: error.body.currentRevision as string, batchId: batchId!, draft: fields }
        }
        if (error.status === 409 && error.code === 'superseded_revision') return { ok: false, error: 'superseded_revision' }
        if (error.status === 403) return { ok: false, error: 'forbidden' }
        if (error.status === 404) return { ok: false, error: 'not_found' }
        if (error.status === 422) return { ok: false, error: 'invalid_state' }
      }
      throw error
    }
  }

  function edit(plate: PlateCardData | OverlaidPlate, fields: EditableFields, reviewed?: { batchId: string; baseRevision: string }): Promise<EditResult<Plate>> {
    setPendingCount(count => count + 1)
    const result = parallel ? save(plate, fields, reviewed) : queue.current.then(() => save(plate, fields, reviewed))
    queue.current = result.catch(() => undefined)
    return result.finally(() => setPendingCount(count => count - 1))
  }

  return { edit, pending: pendingCount > 0 }
}

export type MoveOrigin = { batchId: string | null; revision: number | null }

export function useReorderState() {
  const { api } = useSession()
  const { cache, mutate } = useSWRConfig()
  const ensureBatch = useEnsureBatch()
  const workspace = useWorkspaceBatch()
  const { data: personalBatches } = useBatches(['open'], { mine: true })
  const personal = useBatch(workspace.mode === 'personal' ? mostRecentBatch(personalBatches)?.id ?? null : null, { reuse: true })
  const displayed = workspace.mode === 'selected' ? workspace.detail : personal.data
  const [pendingCount, setPendingCount] = useState(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  async function save(state: string, order: string[]): Promise<EditResult> {
    if (!order.length) return { ok: false, error: 'invalid_state' }
    try {
      if (workspace.mode === 'selected' && workspace.status !== 'ready') return { ok: false, error: workspace.status === 'unavailable' ? 'not_found' : 'forbidden' }
      const id = workspace.mode === 'selected' ? workspace.id : await ensureBatch({ id: order[0], state })
      const key = `/api/batches/${id}`
      const detail = cache.get(key)?.data as BatchDetail | undefined ?? await api.get<BatchDetail>(key)
      await mutate(key, async () => {
        const batch = await api.send<ReviewBatch>('PUT', `${key}/state-order/${encodeURIComponent(state)}`, { batchRevision: detail.batch.revision, order })
        return { ...detail, batch }
      }, {
        optimisticData: { ...detail, batch: { ...detail.batch, stateOrders: { ...detail.batch.stateOrders, [state]: order } } },
        rollbackOnError: true,
        revalidate: false,
      })
      await mutate(key, api.get<BatchDetail>(key), { revalidate: false })
      await mutate(key => typeof key === 'string' && (key === batchesKey() || key.startsWith(`${batchesKey()}?`)))
      return { ok: true }
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 409 && error.code === 'superseded_revision') return { ok: false, error: 'superseded_revision' }
        if (error.status === 403) return { ok: false, error: 'forbidden' }
        if (error.status === 404) return { ok: false, error: 'not_found' }
        if (error.status === 422) return { ok: false, error: 'invalid_state' }
      }
      throw error
    }
  }

  function reorder(state: string, order: string[]): Promise<EditResult> {
    setPendingCount(count => count + 1)
    const proposed = [...order]
    const result = queue.current.then(() => save(state, proposed))
    queue.current = result.catch(() => undefined)
    return result.finally(() => setPendingCount(count => count - 1))
  }

  function capture(): MoveOrigin {
    return { batchId: workspace.mode === 'selected' ? workspace.id : displayed?.batch.id ?? null, revision: displayed?.batch.revision ?? null }
  }

  async function move(state: string, order: string[], promotion: { plateId: string; templateFamily: string }, origin: MoveOrigin): Promise<EditResult> {
    setPendingCount(count => count + 1)
    let key: string | undefined
    try {
      if (workspace.mode === 'selected' && (workspace.status !== 'ready' || origin.batchId !== workspace.id)) return { ok: false, error: 'not_found' }
      if (origin.batchId && origin.revision === null) return { ok: false, error: 'superseded_revision' }
      const id = origin.batchId ?? await ensureBatch({ id: promotion.plateId, state })
      key = '/api/batches/' + id
      await api.send<ReviewBatch>('PUT', key + '/state-order/' + encodeURIComponent(state), { batchRevision: origin.revision ?? 0, order, promotion })
      await mutate(key, api.get<BatchDetail>(key), { revalidate: false })
      await mutate(key => typeof key === 'string' && (key === batchesKey() || key.startsWith(batchesKey() + '?')))
      return { ok: true }
    } catch (error) {
      if (key) {
        const saved = await api.get<BatchDetail>(key)
        await mutate(key, saved, { revalidate: false })
        const plate = saved.plates.find(entry => entry.proposed.id === promotion.plateId)?.proposed
        if (!(error instanceof ApiError) && plate?.templateRole === 'template' && plate.variantOfPlateId === null &&
          plate.templateFamily === promotion.templateFamily && JSON.stringify(saved.batch.stateOrders[state]) === JSON.stringify(order)) return { ok: true }
      }
      if (error instanceof ApiError) {
        if (error.status === 409) return { ok: false, error: 'superseded_revision' }
        if (error.status === 403) return { ok: false, error: 'forbidden' }
        if (error.status === 404) return { ok: false, error: 'not_found' }
        if (error.status === 422) return { ok: false, error: 'invalid_state' }
      }
      throw error
    } finally { setPendingCount(count => count - 1) }
  }

  return { reorder, capture, move, pending: pendingCount > 0 }
}

export function useTaggingModels() {
  const { user, api } = useSession()
  return useSWR<import('./tagging-models').TaggingModels>(user ? '/api/tagging/models' : null, api.get)
}
