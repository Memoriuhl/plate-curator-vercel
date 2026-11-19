'use client'

import { isSharedDraftId } from '@/lib/review/draft-id'
import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import useSWR, { useSWRConfig } from 'swr'
import { ApiError } from '@/lib/client/api'
import { useWorkspaceBatch } from '@/lib/client/hooks'
import { useSession } from '@/lib/client/session'
import { confirmQueueRequest, queueRequestId } from '@/lib/client/queue-intents'
import type {
  EnqueueInput,
  LocalRunStage,
  PipelineRun,
  QueueRunSummary,
  QueueRunView,
} from '@/lib/jobs/queue-types'
import {
  snapshotPipelineOptions,
  type PipelineOptions,
} from '@/lib/jobs/pipeline-options'
import type { RunPlate } from './use-tag-run'
import type { RunModelOptions } from '@/lib/models/selection'
import type { TaggingJob } from '@/lib/jobs/types'
import type { readLocalWorkerCapabilities } from '@/lib/jobs/capabilities'

export const pipelineQueueKey = '/api/local-pipeline/runs'
const queueSummaryKey = `${pipelineQueueKey}?detail=none`
export const gatewayRunsKey = '/api/jobs/runs'

export function pipelineRunDetailKey(id: string) {
  return `${pipelineQueueKey}?detail=${encodeURIComponent(id)}&detailOnly=1`
}

type QueueSnapshot = {
  runs: QueueRunSummary[]
  selected?: QueueRunView
  orphanJobs?: TaggingJob[]
  observedAt?: number
  capabilities?: Awaited<ReturnType<typeof readLocalWorkerCapabilities>>
}

export function PipelineQueueWarmup() {
  const { user, api } = useSession()
  const pathname = usePathname()
  const key =
    process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1'
      ? queueSummaryKey
      : gatewayRunsKey
  useSWR(user && !pathname?.startsWith('/pipeline/runs/') ? key : null, api.get)
  return null
}

/**
 * Translate queue request errors into actions the curator can take without losing a
 * pending intent.
 */
function queueError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === 'publish_in_progress')
      return 'Wait for the current Publish to finish before queuing more work.'
    if (error.code === 'unavailable')
      return 'That hosted model is unavailable. Choose another model.'
    if (error.code === 'invalid_state')
      return 'This Batch or run is no longer available for that action.'
    if (error.code === 'stale_input')
      return 'The Batch changed. Start a new run to use your accepted edits.'
    if (error.status === 403)
      return "Only the Batch's creator or an Owner can change this queue."
    if (error.code === 'request_mismatch')
      return 'This request already exists with different options.'
    if (error.code === 'attempt_limit')
      return 'This run reached five attempts. Start a new run with the current Batch inputs.'
    if (error.code === 'payload_too_large')
      return 'This run is too large to save safely. Select fewer plates.'
  }
  return 'Could not update the queue. Try again; your request will keep the same ID.'
}

/** Read local queue state and expose scoped controls for its runs and worker recovery. */
export function usePipelineQueue(
  existingBatchId?: string | null,
  existingBatchName?: string,
  detailId?: string,
  enabled = true
) {
  const { user, api, ready } = useSession()
  const { mutate } = useSWRConfig()
  const workspace = useWorkspaceBatch()
  const local = process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1'
  const uid = user?.uid ?? null
  const currentUser = useRef(uid)
  useEffect(() => {
    currentUser.current = uid
    return () => {
      currentUser.current = null
    }
  }, [uid])
  const posting = useRef(false)
  const [action, setAction] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [selection, select] = useState<string | undefined>('none')
  const selectedId = detailId ?? selection
  const key = detailId
    ? pipelineRunDetailKey(detailId)
    : selectedId && selectedId !== 'none'
      ? `${pipelineQueueKey}?detail=${encodeURIComponent(selectedId)}`
      : queueSummaryKey
  const list = useSWR<QueueSnapshot>(
    enabled && local && uid ? key : null,
    api.get,
    {
      refreshInterval: (data) =>
        data?.runs.some((run) => run.status === 'running') ? 1250 : 3000,
      keepPreviousData: !detailId,
    }
  )
  const snapshot = list.data
  const loaded = !list.isLoading
  useEffect(() => {
    if (
      !enabled ||
      !uid ||
      key === queueSummaryKey ||
      !loaded ||
      !snapshot ||
      snapshot.selected?.id !== selectedId
    )
      return
    if (detailId) {
      const updated = snapshot.runs.find((run) => run.id === detailId)
      if (!updated) return
      void mutate<QueueSnapshot>(
        queueSummaryKey,
        (previous) => {
          const current = previous?.runs.find((run) => run.id === detailId)
          if (
            !previous ||
            !current ||
            current.updatedAt > updated.updatedAt ||
            (previous.observedAt ?? -Infinity) >
              (snapshot.observedAt ?? -Infinity)
          )
            return previous
          const summary = {
            ...updated,
            queueWait:
              current.status === updated.status ? current.queueWait : undefined,
          }
          return {
            ...previous,
            runs: previous.runs.map((run) =>
              run.id === detailId ? summary : run
            ),
          }
        },
        { revalidate: false }
      )
      return
    }
    const summary = {
      runs: snapshot.runs,
      orphanJobs: snapshot.orphanJobs,
      observedAt: snapshot.observedAt,
      capabilities: snapshot.capabilities,
    }
    void mutate<QueueSnapshot>(
      queueSummaryKey,
      (previous) =>
        (previous?.observedAt ?? -Infinity) > (summary.observedAt ?? -Infinity)
          ? previous
          : summary,
      { revalidate: false }
    )
  }, [enabled, uid, key, loaded, snapshot, selectedId, detailId, mutate])
  useEffect(() => {
    if (!uid || !list.data) return
    try {
      for (const run of list.data.runs)
        if (run.requestedBy === uid) {
          confirmQueueRequest(localStorage, uid, 'enqueue', run.requestId)
          for (const attempt of run.attempts)
            confirmQueueRequest(
              localStorage,
              uid,
              `retry:${run.id}`,
              attempt.requestId
            )
        }
    } catch {
      return
    }
  }, [uid, list.data])
  const disabledReason =
    workspace.mode === 'selected'
      ? workspace.status !== 'ready'
        ? 'Selected Batch is unavailable'
        : workspace.detail?.batch.state !== 'open'
          ? 'Selected Batch is read-only'
          : undefined
      : undefined

  /**
   * Serialize a queue action for the current user and refresh the list after it
   * resolves.
   */
  async function perform<T>(
    label: string,
    operation: () => Promise<T>
  ): Promise<T | null> {
    if (!local || !uid || posting.current) return null
    const requestedBy = uid
    posting.current = true
    setAction(label)
    setMessage('')
    try {
      const run = await operation()
      if (currentUser.current === requestedBy)
        await list.mutate().catch(() => undefined)
      return run
    } catch (error) {
      if (currentUser.current === requestedBy) setMessage(queueError(error))
      return null
    } finally {
      posting.current = false
      if (currentUser.current === requestedBy) setAction(null)
    }
  }

  /**
   * Submit a persisted enqueue intent and acknowledge it only after the run is accepted.
   */
  async function enqueue(
    plates: RunPlate[],
    stages: LocalRunStage[],
    modelId?: string,
    options: PipelineOptions = {},
    previewOnly = false,
    tagModelId?: string,
    researchModelId?: string,
    newBatchName?: string,
    modelOptions?: RunModelOptions
  ) {
    if (!plates.length || disabledReason) return null
    if (previewOnly && workspace.mode !== 'selected' && !existingBatchId) {
      setMessage('Preview requires an existing open Batch.')
      return null
    }
    return perform('enqueue', async () => {
      const batchId =
        workspace.mode === 'selected'
          ? workspace.id
          : previewOnly
            ? existingBatchId!
            : undefined
      const input: Omit<EnqueueInput, 'requestId' | 'batchId'> & {
        batchId?: string
        batchName?: string
      } = {
        ...(batchId
          ? { batchId }
          : { batchName: newBatchName ?? `${plates[0].state} pipeline` }),
        plateIds: plates.map((plate) => plate.id),
        stages,
        options: snapshotPipelineOptions(stages, options),
        previewOnly,
        ...(modelId ? { modelId } : {}),
        ...(tagModelId ? { tagModelId } : {}),
        ...(researchModelId ? { researchModelId } : {}),
        ...(modelOptions ? { modelOptions } : {}),
      }
      const requestId = queueRequestId(
        localStorage,
        uid!,
        'enqueue',
        input,
        () => crypto.randomUUID()
      )
      const saved = await api.send<{ run: PipelineRun; batchId: string }>(
        'POST',
        `${pipelineQueueKey}/selection`,
        { ...input, requestId }
      )
      confirmQueueRequest(localStorage, uid!, 'enqueue', requestId)
      if (
        !batchId &&
        saved.batchId &&
        !isSharedDraftId(saved.batchId) &&
        currentUser.current === uid
      ) {
        const url = new URL(window.location.href)
        if (!url.searchParams.has('batch')) {
          url.searchParams.set('batch', saved.batchId)
          window.history.replaceState(null, '', url)
        }
      }
      void mutate(
        (key) =>
          typeof key === 'string' &&
          (key === '/api/batches' || key.startsWith('/api/batches?'))
      ).catch(() => undefined)
      return saved.run
    })
  }

  /** Request cancellation of the selected run through the shared queue action handler. */
  function cancel(id: string) {
    return perform(
      `cancel:${id}`,
      async () =>
        (
          await api.send<{ run: PipelineRun }>(
            'POST',
            `${pipelineQueueKey}/${id}/cancel`,
            {}
          )
        ).run
    )
  }

  function dismiss(id: string) {
    return perform(
      `dismiss:${id}`,
      async () =>
        (
          await api.send<{ run: PipelineRun }>(
            'POST',
            `${pipelineQueueKey}/${id}/dismiss`,
            {}
          )
        ).run
    )
  }

  /**
   * Retry a run with the persistent request ID used to deduplicate repeated submissions.
   */
  function retry(id: string) {
    return perform(`retry:${id}`, async () => {
      const operation = `retry:${id}`
      const requestId = queueRequestId(
        localStorage,
        uid!,
        operation,
        { id },
        () => crypto.randomUUID()
      )
      const { run } = await api.send<{ run: PipelineRun }>(
        'POST',
        `${pipelineQueueKey}/${id}/retry`,
        { requestId }
      )
      confirmQueueRequest(localStorage, uid!, operation, requestId)
      return run
    })
  }

  /** Apply a completed run and refresh the batch and queue data affected by the write. */
  function apply(id: string) {
    return perform(`apply:${id}`, async () => {
      const batch = await api.send<{ id: string }>(
        'POST',
        `${pipelineQueueKey}/${id}/apply`,
        {}
      )
      await mutate(
        (key) =>
          typeof key === 'string' &&
          (key === `/api/batches/${batch.id}` ||
            key === '/api/batches' ||
            key.startsWith('/api/batches?'))
      ).catch(() => undefined)
      return batch
    })
  }

  /** Submit an image choice for the job waiting in the selected queue run. */
  function chooseImage(id: string, jobId: string, candidateId: string) {
    return perform(`choice:${id}`, async () =>
      api.send('POST', `${pipelineQueueKey}/${id}/choice`, {
        jobId,
        candidateId,
      })
    )
  }

  /** Confirm the stopped worker claim to make the selected run recoverable. */
  function recover(id: string, jobId: string, claimId: string) {
    return perform(`recover:${id}`, async () =>
      api.send('POST', `${pipelineQueueKey}/${id}/recover`, {
        jobId,
        claimId,
        workerStopped: true,
      })
    )
  }

  /** Confirm a stopped worker claim on an orphaned job outside the current queue run. */
  function recoverOrphan(job: TaggingJob) {
    return perform(`recover:${job.id}`, async () =>
      api.send('POST', `/api/jobs/${job.id}/recover`, {
        claimId: job.claimId,
        workerStopped: true,
      })
    )
  }

  return {
    runs: list.data?.runs ?? [],
    orphanJobs: list.data?.orphanJobs ?? [],
    selected:
      list.data?.selected?.id === selectedId ? list.data?.selected : undefined,
    capabilities: list.data?.capabilities,
    observedAt: list.data?.observedAt,
    select,
    loading: local && (ready === false || (list.isLoading && !list.data)),
    error: list.error,
    refresh: list.mutate,
    action,
    message,
    disabledReason,
    selectedBatchName:
      workspace.mode === 'selected' ? workspace.detail?.batch.name : undefined,
    existingBatchName,
    enqueue,
    cancel,
    dismiss,
    retry,
    apply,
    chooseImage,
    recover,
    recoverOrphan,
  }
}
