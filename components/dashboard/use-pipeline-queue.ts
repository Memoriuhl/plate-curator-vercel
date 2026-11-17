'use client'

import { useEffect, useRef, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { ApiError } from '@/lib/client/api'
import { useEnsureBatch, useWorkspaceBatch } from '@/lib/client/hooks'
import { useSession } from '@/lib/client/session'
import { confirmQueueRequest, enqueueIntent, queueRequestId } from '@/lib/client/queue-intents'
import type { EnqueueInput, LocalRunStage, PipelineRun, QueueRunSummary, QueueRunView } from '@/lib/jobs/queue-types'
import type { PipelineOptions } from '@/lib/jobs/pipeline-options'
import type { RunPlate } from './use-tag-run'
import type { TaggingJob } from '@/lib/jobs/types'

export const pipelineQueueKey = '/api/local-pipeline/runs'

function queueError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_state') return 'This Batch or run is no longer available for that action.'
    if (error.code === 'stale_input') return 'The Batch changed. Start a new run to use your accepted edits.'
    if (error.status === 403) return "Only the Batch's creator or an Owner can change this queue."
    if (error.code === 'request_mismatch') return 'This request already exists with different options.'
    if (error.code === 'attempt_limit') return 'This run reached five attempts. Start a new run with the current Batch inputs.'
    if (error.code === 'payload_too_large') return 'This run is too large to save safely. Select fewer plates.'
  }
  return 'Could not update the queue. Try again; your request will keep the same ID.'
}

export function usePipelineQueue(existingBatchId?: string | null) {
  const { user, api } = useSession()
  const { mutate } = useSWRConfig()
  const workspace = useWorkspaceBatch()
  const ensureBatch = useEnsureBatch()
  const local = process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1'
  const uid = user?.uid ?? null
  const currentUser = useRef(uid)
  useEffect(() => { currentUser.current = uid; return () => { currentUser.current = null } }, [uid])
  const posting = useRef(false)
  const [action, setAction] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [selectedId, select] = useState<string | undefined>()
  const key = selectedId ? `${pipelineQueueKey}?detail=${encodeURIComponent(selectedId)}` : pipelineQueueKey
  const list = useSWR<{ runs: QueueRunSummary[]; selected?: QueueRunView; orphanJobs?: TaggingJob[]; observedAt?: number }>(local && uid ? key : null, api.get, { refreshInterval: 3000, keepPreviousData: false })
  useEffect(() => {
    if (!uid || !list.data) return
    try {
      for (const run of list.data.runs) if (run.requestedBy === uid) {
        confirmQueueRequest(localStorage, uid, 'enqueue', run.requestId)
        for (const attempt of run.attempts) confirmQueueRequest(localStorage, uid, `retry:${run.id}`, attempt.requestId)
      }
    } catch { return }
  }, [uid, list.data])
  const disabledReason = workspace.mode === 'selected'
    ? workspace.status !== 'ready' ? 'Selected Batch is unavailable'
      : workspace.detail?.batch.state !== 'open' ? 'Selected Batch is read-only' : undefined
    : undefined

  async function perform<T>(label: string, operation: () => Promise<T>): Promise<T | null> {
    if (!local || !uid || posting.current) return null
    const requestedBy = uid
    posting.current = true; setAction(label); setMessage('')
    try {
      const run = await operation()
      if (currentUser.current === requestedBy) await list.mutate().catch(() => undefined)
      return run
    } catch (error) {
      if (currentUser.current === requestedBy) setMessage(queueError(error))
      return null
    } finally {
      posting.current = false
      if (currentUser.current === requestedBy) setAction(null)
    }
  }

  async function enqueue(plates: RunPlate[], stages: LocalRunStage[], modelId?: string, options: PipelineOptions = {}, previewOnly = false) {
    if (!plates.length || disabledReason) return null
    if (previewOnly && workspace.mode !== 'selected' && !existingBatchId) { setMessage('Preview requires an existing open Batch.'); return null }
    return perform('enqueue', async () => {
      const batchId = workspace.mode === 'selected' ? workspace.id : previewOnly ? existingBatchId! : await ensureBatch(plates[0])
      if (currentUser.current !== uid) throw Error('Session changed')
      const input: Omit<EnqueueInput, 'requestId'> = { batchId, plateIds: plates.map(plate => plate.id), stages, options, previewOnly,
        ...(modelId ? { modelId } : {}) }
      const intent = enqueueIntent(localStorage, uid!, input, () => crypto.randomUUID())
      const { run } = await api.send<{ run: PipelineRun }>('POST', pipelineQueueKey, intent)
      confirmQueueRequest(localStorage, uid!, 'enqueue', intent.requestId)
      return run
    })
  }

  function cancel(id: string) {
    return perform(`cancel:${id}`, async () => (await api.send<{ run: PipelineRun }>('POST', `${pipelineQueueKey}/${id}/cancel`, {})).run)
  }

  function retry(id: string) {
    return perform(`retry:${id}`, async () => {
      const operation = `retry:${id}`
      const requestId = queueRequestId(localStorage, uid!, operation, { id }, () => crypto.randomUUID())
      const { run } = await api.send<{ run: PipelineRun }>('POST', `${pipelineQueueKey}/${id}/retry`, { requestId })
      confirmQueueRequest(localStorage, uid!, operation, requestId)
      return run
    })
  }

  function apply(id: string) {
    return perform(`apply:${id}`, async () => {
      const batch = await api.send<{ id: string }>('POST', `${pipelineQueueKey}/${id}/apply`, {})
      await mutate(key => typeof key === 'string' && (key === `/api/batches/${batch.id}` || key === '/api/batches' || key.startsWith('/api/batches?'))).catch(() => undefined)
      return batch
    })
  }

  function chooseImage(id: string, jobId: string, candidateId: string) {
    return perform(`choice:${id}`, async () => api.send('POST', `${pipelineQueueKey}/${id}/choice`, { jobId, candidateId }))
  }

  function recover(id: string, jobId: string, claimId: string) {
    return perform(`recover:${id}`, async () => api.send('POST', `${pipelineQueueKey}/${id}/recover`, { jobId, claimId, workerStopped: true }))
  }

  function recoverOrphan(job: TaggingJob) {
    return perform(`recover:${job.id}`, async () => api.send('POST', `/api/jobs/${job.id}/recover`, { claimId: job.claimId, workerStopped: true }))
  }

  return { runs: list.data?.runs ?? [], orphanJobs: list.data?.orphanJobs ?? [], selected: list.data?.selected, observedAt: list.data?.observedAt, select, loading: list.isLoading, error: list.error, refresh: list.mutate,
    action, message, disabledReason, enqueue, cancel, retry, apply, chooseImage, recover, recoverOrphan }
}
