'use client'

import { isPublishStop, PIPELINE_BUSY, PIPELINE_BUSY_MESSAGE, PUBLISH_STOP_MESSAGES } from '@/lib/publish/stop'
import { useEffect, useState } from 'react'
import { IoCheckmark, IoCopyOutline, IoPulseOutline } from 'react-icons/io5'
import { useBatchRun, useMe } from '@/lib/client/hooks'
import type { BatchRun } from '@/lib/client/hooks'
import { BASELINE_ERRORS, isBaselineError } from '@/lib/publish/baseline'
import { cn } from '@/components/utils'

const steps = [
  'Submitted',
  'Waiting for approval',
  'Waiting for Publish',
  'Publishing',
  'Published',
]
const phases = [
  'submitted',
  'waiting-for-approval',
  'waiting-for-publish',
  'publishing',
  'published',
]
const failures: Record<string, string> = {
  ...PUBLISH_STOP_MESSAGES,
  [PIPELINE_BUSY]: PIPELINE_BUSY_MESSAGE,
  [BASELINE_ERRORS.stale]: 'The Catalog changed since this Batch was reviewed.',
  [BASELINE_ERRORS.receiptConflict]: 'The interrupted Publish used an unreviewed baseline. Its receipt needs triage.',
  pointer_moved: 'The Catalog moved during Publish.',
  invalid_snapshot: 'The Snapshot could not pass validation.',
  superseded_revision: 'The Batch changed since approval.',
  version_taken: 'The Snapshot version is already taken.',
  lock_lost: 'The Publish lock was lost.',
}

/** Display the approval or publish phase, elapsed time and available recovery actions. */
export function RunStatusView({ run }: { run: BatchRun }) {
  const [now, setNow] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    /** Refresh the clock used to calculate elapsed time for the active release. */
    const update = () => setNow(Date.now())
    update()
    const timer = setInterval(update, 30000)
    return () => clearInterval(timer)
  }, [])
  if (!run.phase)
    return <p className="text-sm text-muted-foreground">Not submitted yet.</p>
  const terminal = ['failed', 'superseded', 'timed-out'].includes(run.phase)
  const current = terminal
    ? run.phase === 'failed'
      ? 3
      : 1
    : phases.indexOf(run.phase)
  const minutes =
    now && run.updatedAt
      ? Math.max(0, Math.floor((now - Date.parse(run.updatedAt)) / 60000))
      : null
  return (
    <section
      aria-label="Approval run"
      className="space-y-3 rounded-2xl bg-[var(--fill)] p-3"
    >
      <div aria-live="polite" aria-atomic="true" className="space-y-3">
        <ol className="flex flex-wrap gap-1 text-xs">
          {steps.map((step, index) => (
            <li
              key={step}
              aria-current={index === current ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1 rounded-full px-2 py-1',
                index === current
                  ? 'bg-primary font-bold text-primary-foreground'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {index < current ? (
                <IoCheckmark aria-label="Done" />
              ) : (
                <span>{index + 1}</span>
              )}
              {step}
              {terminal && index === current ? ` · ${run.phase}` : ''}
            </li>
          ))}
        </ol>
        {run.outcome?.requestedBy && <p className="text-xs text-muted-foreground">Requested by {run.outcome.requestedBy.email} ({run.outcome.requestedBy.uid}).</p>}
        {run.phase === 'published' && (
          <p className="font-bold">
            Published as Snapshot{' '}
            <span className="text-3xl">v{run.outcome?.version ?? '·'}</span>
          </p>
        )}
        {run.phase === 'failed' && (
          <div role="alert">
            <p className="font-bold">
              {failures[run.outcome?.error ?? ''] ??
                'Publish could not complete.'}
            </p>
            {isPublishStop(run.outcome?.error) && <p>The Catalog did not advance.</p>}
            <ul className="list-disc pl-5">
              {run.outcome?.reasons?.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
            {run.outcome?.reviewedVersion !== undefined && <p>Reviewed Catalog v{run.outcome.reviewedVersion}; current Catalog v{run.outcome.liveVersion}.</p>}
            <p>{run.outcome?.error === PIPELINE_BUSY ? 'Confirm Publish again when the pipeline clears.' : isPublishStop(run.outcome?.error) ? 'The Batch remains approved. Resume does not restart this command; a fresh Publish by an active Owner is required.' : (isBaselineError(run.outcome?.error) || run.outcome?.error === 'pointer_moved') ? 'Open Publish and copy to a new Batch for fresh review.' : 'Fix the Batch and approve it again.'}</p>
          </div>
        )}
        {run.phase === 'superseded' && (
          <p>Edited after submission, so this run was replaced.</p>
        )}
        {run.phase === 'timed-out' && <p>No decision before the time limit.</p>}
      </div>
      {run.runId && (
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <code className="max-w-48 truncate" title={run.runId}>
            {run.runId}
          </code>
          <button
            aria-label="Copy run id"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(run.runId!)
                setCopied(true)
              } catch {
                setCopied(false)
              }
            }}
          >
            <IoCopyOutline />
          </button>
          <span role="status">{copied ? 'Copied' : ''}</span>
          {minutes !== null && (
            <span>
              updated {minutes === 0 ? 'just now' : `${minutes} min ago`}
            </span>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * Load the batch's workflow status and render it with the viewer's permitted controls.
 */
export function RunStatus({ batchId, compact = false }: { batchId: string; compact?: boolean }) {
  const me = useMe()
  const run = useBatchRun(batchId)
  if (me.data?.role !== 'owner') return null
  if (run.error) return <p role="alert">Could not load the approval run.</p>
  if (compact && run.data) {
    const phase = run.data.phase
    if (!phase) return null
    if (!['failed', 'superseded', 'timed-out'].includes(phase)) {
      return <details>
        <summary className="caption cursor-pointer">
          <IoPulseOutline className="mx-1 inline size-4 align-text-bottom" aria-hidden="true" />
          {phase === 'published' ? 'Run details' : steps[phases.indexOf(phase)] ?? 'Run details'}
        </summary>
        <RunStatusView run={run.data} />
      </details>
    }
  }
  return run.data ? (
    <RunStatusView run={run.data} />
  ) : (
    <p role="status">Loading approval run…</p>
  )
}
