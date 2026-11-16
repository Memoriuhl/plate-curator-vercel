'use client'

import useSWR, { useSWRConfig } from 'swr'
import type { Plate } from '../catalog/types'
import type { Actor, BatchState, EditableFields, ProposedEdit, ReviewBatch } from '../review/types'
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
