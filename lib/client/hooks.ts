'use client'

import { useMemo, useRef, useState } from 'react'
import type { PlateCardData, PlateDetail } from '../catalog/dashboard-types'
import { isComplete, plateChecks } from '../catalog/plate-checks'
import useSWR, { useSWRConfig } from 'swr'
import type { Plate } from '../catalog/types'
import type { Actor, BatchState, EditableFields, ProposedEdit, ReviewBatch } from '../review/types'
import { ApiError } from './api'
import { useSession } from './session'

export type BatchDetail = {
  batch: ReviewBatch
  plates: { baseline: Plate; proposed: Plate; edit: ProposedEdit | null; revision: string }[]
}

export function batchesKey(states?: BatchState[], opts?: { mine?: boolean }) {
  const params = []
  if (states?.length) params.push(`state=${states.join(',')}`)
  if (opts?.mine) params.push('mine=1')
  return `/api/batches${params.length ? `?${params.join('&')}` : ''}`
}

export function useMe() {
  const { user, api } = useSession()
  return useSWR<Actor>(user ? '/api/me' : null, api.get)
}

export function useBatches(states?: BatchState[], opts?: { mine?: boolean }) {
  const { user, api } = useSession()
  return useSWR<ReviewBatch[]>(user ? batchesKey(states, opts) : null, api.get)
}

export function useBatch(id: string | null) {
  const { user, api } = useSession()
  return useSWR<BatchDetail>(user && id ? `/api/batches/${id}` : null, api.get)
}

export function usePlateDetail(id: string | null) {
  const { user, api } = useSession()
  return useSWR<PlateDetail>(user && id ? `/api/plates/${id}` : null, api.get)
}

export function useReviewActions() {
  const { api } = useSession()
  const { mutate } = useSWRConfig()
  const refresh = (batchId?: string) => mutate((key) => typeof key === 'string' && (key.startsWith('/api/batches?') || key === '/api/batches' || key === `/api/batches/${batchId}`))

  return {
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

export function useDraftOverlay(plates: PlateCardData[]): OverlaidPlate[] {
  const { data: batches } = useBatches(['open'], { mine: true })
  const { data: detail } = useBatch(mostRecentBatch(batches)?.id ?? null)
  return useMemo(() => {
    const entries = new Map(detail?.plates.map(entry => [entry.proposed.id, entry]))
    return plates.map(card => {
      const entry = entries.get(card.id)
      if (!entry) return { ...card, changedInBatch: false }
      const { proposed } = entry
      const checks = plateChecks(proposed, card.imageUrl)
      return {
        ...card, tags: proposed.tags, templateFamily: proposed.templateFamily ?? null,
        templateRole: proposed.templateRole ?? null, variantOfPlateId: proposed.variantOfPlateId ?? null,
        isStandard: proposed.isStandard ?? false, revision: entry.revision, checks,
        complete: isComplete(checks), changedInBatch: entry.edit !== null,
      }
    })
  }, [plates, detail])
}

export type EditResult =
  | { ok: true; proposed: Plate }
  | { ok: false; error: 'stale_plate'; current: Plate; draft: EditableFields }
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

export function useEditPlate() {
  const { api } = useSession()
  const { cache, mutate } = useSWRConfig()
  const ensureBatch = useEnsureBatch()
  const [pendingCount, setPendingCount] = useState(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  async function save(plate: PlateCardData | OverlaidPlate, fields: EditableFields): Promise<EditResult> {
    try {
      const id = await ensureBatch(plate)
      const key = `/api/batches/${id}`
      const detail = cache.get(key)?.data as BatchDetail | undefined ?? await api.get<BatchDetail>(key)
      const baseRevision = detail.plates.find(entry => entry.proposed.id === plate.id)?.revision ?? plate.revision
      const result = await api.send<{ batch: ReviewBatch; plate: Plate }>('PATCH', `${key}/plates/${plate.id}`, { baseRevision, fields })
      await mutate(key, api.get<BatchDetail>(key), { revalidate: false })
      await mutate(key => typeof key === 'string' && (key === batchesKey() || key.startsWith(`${batchesKey()}?`)))
      return { ok: true, proposed: result.plate }
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 409 && error.code === 'stale_plate') {
          return { ok: false, error: 'stale_plate', current: error.body.current as Plate, draft: fields }
        }
        if (error.status === 409 && error.code === 'superseded_revision') return { ok: false, error: 'superseded_revision' }
        if (error.status === 403) return { ok: false, error: 'forbidden' }
        if (error.status === 404) return { ok: false, error: 'not_found' }
        if (error.status === 422) return { ok: false, error: 'invalid_state' }
      }
      throw error
    }
  }

  function edit(plate: PlateCardData | OverlaidPlate, fields: EditableFields): Promise<EditResult> {
    setPendingCount(count => count + 1)
    const result = queue.current.then(() => save(plate, fields))
    queue.current = result.catch(() => undefined)
    return result.finally(() => setPendingCount(count => count - 1))
  }

  return { edit, pending: pendingCount > 0 }
}
