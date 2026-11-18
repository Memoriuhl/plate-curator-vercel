'use client'

import { useEffect, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import { ApiError } from '@/lib/client/api'
import { useEnsureBatch, useWorkspaceBatch } from '@/lib/client/hooks'
import { useSession } from '@/lib/client/session'
import type { TaggingModelId } from '@/lib/tagging/models'
import type {
  FieldSuggestion,
  PipelineStage,
  StageError,
} from '@/lib/jobs/types'
import type { StoryFields } from '@/lib/catalog/types'

export type RunPlate = StoryFields & {
  id: string
  state: string
  displayName: string
  revision: string
  tags: string[]
  hasStory?: boolean
  description?: string | null
  checks?: {
    funFacts: { status: string }
    description?: { value: string | null }
  }
}
export type TagJob = {
  previewOnly?: boolean
  state: 'queued' | 'claimed' | 'completed' | 'expired' | 'failed' | 'cancelled'
  suggestions: string[]
  inputHash?: string
  stage?: PipelineStage
  fieldSuggestion?: FieldSuggestion | null
  stageError?: StageError | null
}
export type RunEntry = {
  plate: RunPlate
  jobId?: string
  acceptedAt?: number
  job: TagJob
  error?: string
}

export const editErrors = {
  standard_change_unconfirmed: 'Reload and confirm the Standard change again.',
  standard_required: 'Choose another Standard first.',
  standard_invalid_template: 'The Standard must be a live Template.',
  forbidden: "Only the batch's creator or an Owner can edit it.",
  superseded_revision: 'This batch has a newer revision. Reload and try again.',
  invalid_state: 'This batch is no longer open for editing.',
  not_found: 'This plate or batch could not be found.',
  stale_plate: 'Someone changed this while you were editing.',
}

/** Explain which condition prevented the tagging workflow from starting or completing. */
function reason(error: unknown, stage?: PipelineStage) {
  if (error instanceof ApiError) {
    if (error.status === 403) return editErrors.forbidden
    if (error.status === 422) return editErrors.invalid_state
    if (error.status === 404) return editErrors.not_found
  }
  return stage
    ? 'Could not start this stage. Check your connection and try again.'
    : 'Could not request tags. Check your connection and try again.'
}

/** Manage a tagging run's selected plates, per-plate job state and polling lifecycle. */
export function useTagRun() {
  const { api } = useSession()
  const { mutate } = useSWRConfig()
  const [modelError, setModelError] = useState<string>()
  const ensureBatch = useEnsureBatch()
  const workspace = useWorkspaceBatch()
  const selection = workspace.mode === 'selected' ? workspace.id : null
  const disabledReason =
    workspace.mode === 'selected'
      ? workspace.status === 'loading'
        ? 'Loading selected Batch'
        : workspace.status === 'unavailable'
          ? 'Selected Batch is unavailable'
          : workspace.status !== 'ready' ||
              workspace.detail?.batch.state !== 'open'
            ? 'Selected Batch is read-only for Tag'
            : undefined
      : undefined
  const [batchId, setBatchId] = useState<string | null>(null)
  const [entries, setEntries] = useState<RunEntry[]>([])
  const [starting, setStarting] = useState(false)
  const generation = useRef(0)
  const posting = useRef(false)
  const lastModel = useRef<TaggingModelId | undefined>(undefined)
  const lastStage = useRef<PipelineStage | undefined>(undefined)
  const entriesRef = useRef(entries)
  useEffect(() => {
    entriesRef.current = entries
  }, [entries])
  const pollingNeeded = entries.some(
    (entry) =>
      entry.jobId &&
      !entry.error &&
      ['queued', 'claimed'].includes(entry.job.state)
  )

  const [previousSelection, setPreviousSelection] = useState(selection)
  if (previousSelection !== selection) {
    setPreviousSelection(selection)
    setModelError(undefined)
    setEntries([])
    setStarting(false)
    setBatchId(null)
  }

  useEffect(
    () => () => {
      generation.current++
    },
    [selection]
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
            update = { error: reason(error, entry.job.stage) }
          }
          if (!stopped && version === generation.current)
            setEntries((current) =>
              current.map((item) =>
                item.jobId === entry.jobId ? { ...item, ...update } : item
              )
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

  /**
   * Start the requested stage or tagging run and track each submitted job against the
   * current generation.
   */
  async function start(
    plates: RunPlate[],
    retry = false,
    model?: TaggingModelId,
    stage?: PipelineStage,
    onAccepted?: (runId: string) => void
  ) {
    if (stage && process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1') return
    if (!retry) {
      lastModel.current = model
      lastStage.current = stage
    }
    const chosen = retry ? lastModel.current : model
    const chosenStage = retry ? lastStage.current : stage
    if (chosenStage && process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1') return
    if (!plates.length || posting.current || disabledReason) return
    posting.current = true
    setModelError(undefined)
    setStarting(true)
    const version = retry ? generation.current : ++generation.current
    const initial = plates.slice(0, 25).map((plate) => ({
      plate,
      job: {
        state: 'queued' as const,
        suggestions: [],
        ...(chosenStage ? { stage: chosenStage } : {}),
      },
    }))
    setEntries((current) =>
      retry
        ? current.map(
            (entry) =>
              initial.find((item) => item.plate.id === entry.plate.id) ?? entry
          )
        : initial
    )
    /** Apply a job status update only while its run generation is still current. */
    const update = (id: string, changes: Partial<RunEntry>) => {
      if (version === generation.current)
        setEntries((current) =>
          current.map((entry) =>
            entry.plate.id === id ? { ...entry, ...changes } : entry
          )
        )
    }
    try {
      const batchId =
        workspace.mode === 'selected'
          ? workspace.id
          : await ensureBatch(plates[0])
      if (version !== generation.current) return
      setBatchId(batchId)
      let accepted = false
      for (const { plate } of initial) {
        if (version !== generation.current) break
        try {
          const result = await api.send<{ jobId: string; runId: string }>(
            'POST',
            `/api/batches/${batchId}/plates/${encodeURIComponent(plate.id)}/${chosenStage ? 'pipeline' : 'tagging'}`,
            {
              ...(chosen ? { model: chosen } : {}),
              ...(chosenStage ? { stage: chosenStage } : {}),
            }
          )
          update(plate.id, { jobId: result.jobId, acceptedAt: Date.now() })
          if (!accepted && version === generation.current) {
            accepted = true
            onAccepted?.(result.runId)
          }
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.status === 422 &&
            error.code === 'invalid_state'
          ) {
            if (version === generation.current)
              setModelError(
                'That model is no longer available. Choose another.'
              )
            void mutate('/api/tagging/models').catch(() => undefined)
          }
          update(plate.id, { error: reason(error, chosenStage) })
        }
      }
    } catch (error) {
      for (const { plate } of initial)
        update(plate.id, { error: reason(error, chosenStage) })
    } finally {
      posting.current = false
      if (version === generation.current) setStarting(false)
    }
  }

  /** Dismiss the current run and invalidate updates still in flight. */
  function dismiss() {
    generation.current++
    setEntries([])
    setStarting(false)
  }
  return {
    modelError,
    entries,
    batchId,
    disabledReason,
    starting,
    start,
    dismiss,
  }
}
