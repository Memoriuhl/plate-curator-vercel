'use client'

import { isSharedDraftId } from '@/lib/review/draft-id'
import { useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import useSWR, { useSWRConfig } from 'swr'
import { ApiError } from '@/lib/client/api'
import { useWorkspaceBatch } from '@/lib/client/hooks'
import { useSession } from '@/lib/client/session'
import { useLiveRefresh } from '@/lib/client/live-signal'
import { confirmQueueRequest, queueRequestId } from '@/lib/client/queue-intents'
import type {
  EnqueueInput,
  LocalRunStage,
  PipelineRun,
  QueueRunSummary,
  QueueRunView,
  RunStatus,
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

/**
 * The safety refresh a run list needs while its listener is healthy. While a run is
 * queued or running, a worker going quiet changes what the drawer shows without any
 * write, so the list re-reads every minute. With nothing active, every change it shows
 * is signalled, so it re-reads only every ten minutes to recover a lost signal. A failed
 * listener polls every 30 seconds either way.
 */
export function runListSafetyMs(
  runs: readonly { status: RunStatus }[] | undefined
) {
  return runs?.some(
    (run) => run.status === 'queued' || run.status === 'running'
  )
    ? 60_000
    : 600_000
}

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

/** One queue view's part in a live refresh round. */
type QueueRefresh = {
  /** The request the view reads. */
  key: string
  get: <T>(path: string) => Promise<T>
  /** Store a response under a view's key without requesting it again. */
  write: (key: string, data: QueueSnapshot) => Promise<unknown>
  /** Request the view's own key. */
  revalidate: () => Promise<unknown>
}

let queueRound: { views: QueueRefresh[]; done: Promise<void> } | null = null
/**
 * The number of the newest queue read, counting up for the life of the tab. Live rounds and
 * every SWR read of a queue key (an action's refresh, Refresh, focus) take the next number
 * when their request starts.
 */
let lastRead = 0
/** The newest read each queue request has started or taken a response from. */
const appliedRead = new Map<string, number>()
/** The queue views mounted in the tab, so an action can refresh all of them at once. */
const mountedViews = new Set<QueueRefresh>()

/**
 * The SWR fetcher for queue keys. It numbers each read when it starts, so a live round that
 * started earlier can't replace its answer.
 */
export function queueFetcher(get: QueueRefresh['get']) {
  return <T>(key: string) => {
    appliedRead.set(key, ++lastRead)
    return get<T>(key)
  }
}

/**
 * Refresh a queue view as part of the tab's live round. The hub starts every due view's
 * refresh at once, and views that join before the next microtask share requests: an open
 * run's results ride on a list request that selects the run, or turn the list's unselected
 * request into one. The list and an open run's results then cost one request per round.
 */
function refreshQueue(view: QueueRefresh): Promise<void> {
  if (!queueRound) {
    const views: QueueRefresh[] = []
    queueRound = {
      views,
      done: Promise.resolve().then(() => {
        queueRound = null
        return refreshTogether(views, ++lastRead)
      }),
    }
  }
  // A view that is already in the round shares its request.
  if (!queueRound.views.some((joined) => joined.key === view.key))
    queueRound.views.push(view)
  return queueRound.done
}

/**
 * Refresh every queue view mounted in the tab in one round. After an action, the list and an
 * open run's results both read the change, and both reject any round that started earlier.
 */
function refreshMounted() {
  return Promise.all([...mountedViews].map(refreshQueue))
}

/** The run a results-only request reads, or null for a list request. */
function detailOnlyRun(key: string) {
  const params = new URL(key, 'https://queue.invalid').searchParams
  return params.get('detailOnly') === '1' ? params.get('detail') : null
}

const listSelecting = (runId: string) =>
  `${pipelineQueueKey}?detail=${encodeURIComponent(runId)}`

async function refreshTogether(views: QueueRefresh[], round: number) {
  // A round can start while an earlier read of the same request is still out, and the
  // responses can come back in either order. A request takes a round's response only if
  // the round started after every read it has started or taken, so a slow response never
  // rolls a view back. A view's own SWR read is numbered by queueFetcher when it starts:
  // SWR drops that read's answer if an older response is written meanwhile.
  const take = (key: string) => {
    if ((appliedRead.get(key) ?? 0) >= round) return false
    appliedRead.set(key, round)
    return true
  }
  const write = (view: QueueRefresh, data: QueueSnapshot) =>
    take(view.key) ? view.write(view.key, data) : undefined
  const revalidate = (view: QueueRefresh) => view.revalidate()
  type ListRequest = {
    view: QueueRefresh
    request: string
    riders: { view: QueueRefresh; runId: string }[]
  }
  const lists = new Map<string, ListRequest>()
  const alone: QueueRefresh[] = []
  for (const view of views)
    if (detailOnlyRun(view.key) === null)
      lists.set(view.key, { view, request: view.key, riders: [] })
  for (const view of views) {
    const runId = detailOnlyRun(view.key)
    if (runId === null) continue
    const unselected = lists.get(queueSummaryKey)
    const list =
      lists.get(listSelecting(runId)) ??
      (unselected?.riders.length === 0 ? unselected : undefined)
    if (!list) {
      alone.push(view)
      continue
    }
    list.request = listSelecting(runId)
    list.riders.push({ view, runId })
  }
  await Promise.all([
    ...alone.map(revalidate),
    ...[...lists.values()].map(async ({ view, request, riders }) => {
      if (!riders.length) return revalidate(view)
      let data: QueueSnapshot
      try {
        data = await view.get<QueueSnapshot>(request)
      } catch {
        // Let each view request its own key, so the error lands where it shows.
        return Promise.all(
          [view, ...riders.map((rider) => rider.view)].map(revalidate)
        )
      }
      const { selected, ...list } = data
      return Promise.all([
        write(view, view.key === request ? data : list),
        ...riders.map(({ view: rider, runId }) =>
          selected?.id === runId
            ? write(rider, {
                runs: data.runs.filter((run) => run.id === runId),
                selected,
                observedAt: data.observedAt,
              })
            : // The list could not select the run (it is not listed), so ask directly.
              revalidate(rider)
        ),
      ])
    }),
  ])
}

export function PipelineQueueWarmup() {
  const { user, api } = useSession()
  const pathname = usePathname()
  const key =
    process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1'
      ? queueSummaryKey
      : gatewayRunsKey
  useSWR(
    user && !pathname?.startsWith('/pipeline/runs/') ? key : null,
    key === queueSummaryKey ? queueFetcher(api.get) : api.get
  )
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
  const active = enabled && local && uid !== null
  const list = useSWR<QueueSnapshot>(
    active ? key : null,
    queueFetcher(api.get),
    { keepPreviousData: !detailId }
  )
  const refetch = list.mutate
  const view = useMemo<QueueRefresh>(
    () => ({
      key,
      get: api.get,
      write: (target, data) => mutate(target, data, { revalidate: false }),
      revalidate: () => refetch(),
    }),
    [key, api.get, mutate, refetch]
  )
  useEffect(() => {
    if (!active) return
    mountedViews.add(view)
    return () => {
      mountedViews.delete(view)
    }
  }, [active, view])
  // Refetch when the server signals a queue change, sharing the round's request with the
  // tab's other queue views.
  const live = useLiveRefresh(['pipeline'], () => refreshQueue(view), {
    enabled: active,
    key,
    safetyMs: runListSafetyMs(list.data?.runs),
  })
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
   * Serialize a queue action for the current user, then refresh every mounted queue view
   * in one round after it resolves.
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
        await refreshMounted().catch(() => undefined)
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
    refresh: refreshMounted,
    live,
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
