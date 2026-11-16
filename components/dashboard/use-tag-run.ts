'use client'

import { useEffect, useRef, useState } from 'react'
import { ApiError } from '@/lib/client/api'
import { useEnsureBatch } from '@/lib/client/hooks'
import { useSession } from '@/lib/client/session'

export type RunPlate = {
  id: string
  state: string
  displayName: string
  revision: string
  tags: string[]
}
export type TagJob = {
  state: 'queued' | 'claimed' | 'completed' | 'expired'
  suggestions: string[]
}
export type RunEntry = {
  plate: RunPlate
  jobId?: string
  acceptedAt?: number
  job: TagJob
  error?: string
}

export const editErrors = {
  forbidden: "Only the batch's creator or an Owner can edit it.",
  superseded_revision: 'This batch has a newer revision. Reload and try again.',
  invalid_state: 'This batch is no longer open for editing.',
  not_found: 'This plate or batch could not be found.',
  stale_plate: 'Someone changed this while you were editing.',
}

function reason(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 403) return editErrors.forbidden
    if (error.status === 422) return editErrors.invalid_state
    if (error.status === 404) return editErrors.not_found
  }
  return 'Could not request tags. Check your connection and try again.'
}

export function useTagRun() {
  const { api } = useSession()
  const ensureBatch = useEnsureBatch()
  const [entries, setEntries] = useState<RunEntry[]>([])
  const [starting, setStarting] = useState(false)
  const generation = useRef(0)
  const posting = useRef(false)
  const entriesRef = useRef(entries)
  useEffect(() => {
    entriesRef.current = entries
  }, [entries])
  const pollingNeeded = entries.some(
    (entry) =>
      entry.jobId &&
      !entry.error &&
      ['queued', 'claimed'].includes(entry.job.state),
  )

  useEffect(
    () => () => {
      generation.current++
    },
    [],
  )

  useEffect(() => {
    if (!pollingNeeded) return
    const version = generation.current
    let stopped = false
    let polling = false
    const timer = setInterval(async () => {
      if (polling) return
      polling = true
      try {
        for (const entry of entriesRef.current) {
          if (stopped || version !== generation.current) return
          if (
            !entry.jobId ||
            entry.error ||
            !['queued', 'claimed'].includes(entry.job.state)
          )
            continue
          let update: Partial<RunEntry>
          try {
            const job = await api.get<TagJob>(`/api/jobs/${entry.jobId}`)
            update = { job }
          } catch (error) {
            if (
              error instanceof ApiError &&
              error.status === 404 &&
              Date.now() - entry.acceptedAt! < 10000
            )
              continue
            update = { error: reason(error) }
          }
          if (!stopped && version === generation.current)
            setEntries((current) =>
              current.map((item) =>
                item.jobId === entry.jobId ? { ...item, ...update } : item,
              ),
            )
        }
      } finally {
        polling = false
      }
    }, 3000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [api, pollingNeeded])

  async function start(plates: RunPlate[], retry = false) {
    if (!plates.length || posting.current) return
    posting.current = true
    setStarting(true)
    const version = retry ? generation.current : ++generation.current
    const initial = plates
      .slice(0, 25)
      .map((plate) => ({
        plate,
        job: { state: 'queued' as const, suggestions: [] },
      }))
    setEntries((current) =>
      retry
        ? current.map(
            (entry) =>
              initial.find((item) => item.plate.id === entry.plate.id) ?? entry,
          )
        : initial,
    )
    const update = (id: string, changes: Partial<RunEntry>) => {
      if (version === generation.current)
        setEntries((current) =>
          current.map((entry) =>
            entry.plate.id === id ? { ...entry, ...changes } : entry,
          ),
        )
    }
    try {
      const batchId = await ensureBatch(plates[0])
      for (const { plate } of initial) {
        if (version !== generation.current) break
        try {
          const result = await api.send<{ jobId: string; runId: string }>(
            'POST',
            `/api/batches/${batchId}/plates/${encodeURIComponent(plate.id)}/tagging`,
            {},
          )
          update(plate.id, { jobId: result.jobId, acceptedAt: Date.now() })
        } catch (error) {
          update(plate.id, { error: reason(error) })
        }
      }
    } catch (error) {
      for (const { plate } of initial)
        update(plate.id, { error: reason(error) })
    } finally {
      posting.current = false
      if (version === generation.current) setStarting(false)
    }
  }

  function dismiss() {
    generation.current++
    setEntries([])
    setStarting(false)
  }
  return { entries, starting, start, dismiss }
}
