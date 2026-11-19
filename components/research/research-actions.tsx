'use client'

import { useRef, useState, useSyncExternalStore } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { useRouter } from 'next/navigation'
import { useEnsureBatch, useMe, useWorkspaceBatch } from '@/lib/client/hooks'
import { useSession } from '@/lib/client/session'
import { ApiError } from '@/lib/client/api'
import { researchMessage } from '@/lib/client/research'
import type {
  ResearchDraft,
  ResearchExecutor,
  ResearchJob,
} from '@/lib/research/types'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import { ResearchResult } from './research-result'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type Intent = {
  requestKey: string
  batchId: string
  executor: ResearchExecutor
  jobId?: string
  replaceJobId?: string
}
type Reply = { ok: true; value: ResearchJob }
/**
 * Supply the no-op subscription for a hydration flag that never changes after mounting.
 */
const subscribeHydration = () => () => {}
/** Enable browser-only research state once React reads the client snapshot. */
const clientSnapshot = () => true
/** Keep browser-only research state hidden during the server render. */
const serverSnapshot = () => false

/**
 * Mount research controls for the signed-in plate and batch scope once the client is
 * ready.
 */
export function ResearchActions({ plate }: { plate: PlateCardData }) {
  const { user } = useSession()
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    clientSnapshot,
    serverSnapshot
  )
  const workspace = useWorkspaceBatch()
  const scope = workspace.mode === 'selected' ? workspace.id : 'personal'
  return user && hydrated ? (
    <ResearchRun
      key={`${user.uid}/${scope}/${plate.id}`}
      plate={plate}
      storageKey={`research:v1:${user.uid}:${scope}:${plate.id}`}
    />
  ) : null
}

/** Manage the current plate's research request, saved intent, polling and acceptance. */
function ResearchRun({
  plate,
  storageKey,
}: {
  plate: PlateCardData
  storageKey: string
}) {
  const { api } = useSession()
  const me = useMe()
  const workspace = useWorkspaceBatch()
  const ensureBatch = useEnsureBatch()
  const router = useRouter()
  const { mutate } = useSWRConfig()
  const [intent, setIntent] = useState<Intent | null>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
      return saved?.requestKey &&
        saved.batchId &&
        ['eve', 'desktop'].includes(saved.executor)
        ? saved
        : null
    } catch {
      return null
    }
  })
  const [executor, setExecutor] = useState<ResearchExecutor>(
    intent?.executor ?? 'eve'
  )
  const [pending, setPending] = useState(false)
  const posting = useRef(false)
  const [message, setMessage] = useState('')
  // Cache the latest job response so status stays visible between active polls.
  const research = useSWR<Reply>(
    intent?.jobId ? `/api/research/${intent.jobId}` : null,
    api.get,
    {
      /** Poll only while the tracked research job is queued or running. */ refreshInterval:
        (reply) =>
          reply && ['queued', 'running'].includes(reply.value.state) ? 2000 : 0,
    }
  )
  const job = research.data?.value
  const blocked = workspace.mode === 'selected' && workspace.status !== 'ready'
  /** Persist the request intent so a reload can recover the same research run. */
  function remember(next: Intent) {
    setIntent(next)
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      setMessage(
        'Browser storage is unavailable; keep this page open to retain the run link.'
      )
    }
  }
  /**
   * Start a research job with the selected model and retain its recoverable request
   * identity.
   */
  async function start(replace = false) {
    if (posting.current || blocked) return
    posting.current = true
    setPending(true)
    setMessage('')
    try {
      const next =
        intent && !intent.jobId
          ? intent
          : {
              requestKey: crypto.randomUUID(),
              batchId:
                workspace.mode === 'selected'
                  ? workspace.id
                  : await ensureBatch(plate),
              executor,
              ...(replace && job ? { replaceJobId: job.id } : {}),
            }
      remember(next)
      const reply = await api.send<Reply>(
        'POST',
        `/api/batches/${next.batchId}/plates/${encodeURIComponent(plate.id)}/research`,
        {
          requestKey: next.requestKey,
          executor: next.executor,
          ...(next.replaceJobId ? { replaceJobId: next.replaceJobId } : {}),
        }
      )
      remember({ ...next, jobId: reply.value.id })
      // Fill the job entry from the start response so status can render before the next poll.
      await mutate(`/api/research/${reply.value.id}`, reply, {
        revalidate: false,
      })
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status < 500 || error.code === 'unavailable')
      ) {
        setIntent(intent)
        try {
          if (intent) localStorage.setItem(storageKey, JSON.stringify(intent))
          else localStorage.removeItem(storageKey)
        } catch {}
      }
      setMessage(researchMessage(error))
    } finally {
      posting.current = false
      setPending(false)
    }
  }
  /**
   * Save the selected sourced fields to the batch and refresh the plate and job views.
   */
  async function accept(fields: string[], draft: ResearchDraft) {
    if (!job || pending || blocked) return
    setPending(true)
    setMessage('')
    try {
      const saved = await api.send<{
        value?: { skipped?: string[]; rejected?: unknown[] }
      }>('POST', `/api/research/${job.id}/accept`, {
        fields,
        draft,
        baseRevision: plate.revision,
      })
      const leftOut = saved.value?.rejected?.length ?? 0
      await Promise.all([
        mutate(`/api/batches/${job.batchId}`),
        research.mutate(),
        mutate(
          (key) => typeof key === 'string' && key.startsWith('/api/batches?')
        ),
      ])
      // Reload the route payload after refreshing the job and draft caches.
      router.refresh()
      setMessage(
        leftOut
          ? `Saved to the Batch. ${leftOut} item${leftOut === 1 ? '' : 's'} left out: not supported by the captured sources.`
          : 'Saved to the Batch.'
      )
    } catch (error) {
      setMessage(researchMessage(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <section
      aria-label="Plate research"
      className="grid min-w-0 gap-3 border-t border-[var(--hairline)] pt-4"
    >
      <h3 className="label">Research</h3>
      {me.data?.role === 'owner' ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1">
            <span className="caption">Research host</span>
            <Select
              value={executor}
              disabled={pending || (!!intent && !intent.jobId)}
              onValueChange={(value) => setExecutor(value as ResearchExecutor)}
            >
              <SelectTrigger aria-label="Research host" className="min-w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="eve">Vercel / Eve</SelectItem>
                <SelectItem value="desktop">Desktop / Ollama</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <Button
            variant="outline"
            disabled={pending || blocked}
            onClick={() => void start(!!job)}
          >
            {pending
              ? 'Working…'
              : intent && !intent.jobId
                ? 'Retry research request'
                : job
                  ? 'Start replacement run'
                  : 'Research this plate'}
          </Button>
        </div>
      ) : (
        <p className="caption">An Owner can start research.</p>
      )}
      {job ? (
        <p role="status" className="caption">
          {job.executor === 'desktop' ? 'Desktop / Ollama' : 'Vercel / Eve'} ·{' '}
          {job.state}
          {job.executor === 'desktop' && job.state === 'queued'
            ? ' · Waiting for the desktop worker; it may be offline.'
            : ''}
          {job.error ? ` · ${job.error}` : ''}
        </p>
      ) : null}

      {research.error ? (
        <p role="alert">{researchMessage(research.error)}</p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {job?.result ? (
        <ResearchResult
          key={job.id}
          plate={plate}
          result={job.result}
          canEditDraft={me.data?.role === 'owner'}
          pending={pending || blocked || job.state !== 'completed'}
          onAccept={(fields, draft) => void accept(fields, draft)}
        />
      ) : null}
    </section>
  )
}
