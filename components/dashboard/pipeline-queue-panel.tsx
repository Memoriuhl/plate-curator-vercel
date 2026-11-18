'use client'

import Link from 'next/link'
import { batchHref } from '@/lib/review/href'

import { useState, type ReactNode } from 'react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import { IoStopCircleOutline, IoTrashOutline } from 'react-icons/io5'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { QueueRunSummary, QueueWait } from '@/lib/jobs/queue-types'
import type { usePipelineQueue } from './use-pipeline-queue'
import { PipelineRunCard } from './pipeline-run-card'
import { PipelineRailSkeleton, PipelineRunRail } from './pipeline-run-rail'
import { plateOutcomeSummary, queueProgress } from '@/lib/jobs/run-progress'
import styles from './pipeline-runs.module.css'

type QueueControls = Pick<ReturnType<typeof usePipelineQueue>, 'runs' | 'loading' | 'error' | 'refresh' | 'action' | 'message' | 'cancel' | 'dismiss' | 'retry'> &
  Partial<Pick<ReturnType<typeof usePipelineQueue>, 'orphanJobs' | 'recoverOrphan' | 'observedAt'>>

function resultsHref(run: QueueRunSummary) {
  return batchHref(`/pipeline/runs/${encodeURIComponent(run.id)}`, run.batchId)
}

const queueWaitLabels: Record<QueueWait, string> = {
  starting_workflow: 'Starting workflow',
  dispatching: 'Preparing the next step',
  settling: 'Saving the previous result',
  worker_offline: 'Waiting for a local worker to connect',
  saved_sources_worker: 'Waiting for a worker with saved-source support',
  image_worker: 'Waiting for a worker with image enhancement',
  gpu_busy: 'Waiting for a GPU slot',
  io_busy: 'Waiting for an I/O slot',
  gpu_recovery: 'Waiting for a stopped GPU job to be recovered',
  io_recovery: 'Waiting for stopped I/O jobs to be recovered',
  hosted: 'Waiting for the hosted worker',
  worker_claim: 'Waiting for the local worker to pick up this step',
}

function label(run: QueueRunSummary) {
  const attempt = run.attempts.at(-1)!
  if (run.cancelRequestedAt !== undefined && run.status === 'running') return 'Cancellation requested · waiting for the active stage to finish'
  if (run.waitReason === 'recovery') return 'Recovery needed · waiting for the worker to confirm it stopped'
  if (run.waitReason === 'image_choice') return 'Waiting for your image selection'
  if (attempt.outcome === 'no_result') return `Failed · ${attempt.error?.replaceAll('_', ' ') ?? 'no supported suggestion'}`
  if (attempt.outcome === 'partial') return 'Completed with gaps'
  return run.status[0].toUpperCase() + run.status.slice(1)
}

export function PipelineQueuePanel({ queue, header, requester }: { queue: QueueControls; header?: ReactNode; requester?(uid: string): string | undefined }) {
  const [verifiedClaim, setVerifiedClaim] = useState<string | null>(null)
  return <section aria-label="Pipeline queue and history" className={styles.panel}>
    {header ?? <h2 className="sr-only">Pipeline queue and history</h2>}
    {queue.error ? <Button size="sm" variant="ghost" onClick={() => void queue.refresh()}>Refresh queue</Button> : null}

    {queue.error ? <p role="alert">Could not load saved runs. Refresh to try again.</p> : null}
    {!queue.loading && !queue.error && !queue.runs.length ? <p className="caption">No local runs yet.</p> : null}
    {queue.message ? <p role="alert">{queue.message}</p> : null}
    {queue.orphanJobs?.map(job => <div key={job.id} className="grid gap-2 rounded-[var(--radius-md)] bg-[var(--fill)] p-3">
      <p role="status">Earlier local {job.stage ?? 'tag'} job · {job.inputPlate?.displayName ?? job.plateId} · {job.recoveryNeededAt !== undefined ? 'worker outcome unknown' : 'running'}</p>
      {job.recoveryNeededAt !== undefined ? <details><summary className="cursor-pointer">Recover earlier local worker</summary>
        <p className="caption">Verify worker {job.workerId} has stopped executing. Releasing its slot cannot stop it.</p>
        <label className="caption flex items-center gap-2"><input type="checkbox" checked={verifiedClaim === job.claimId} onChange={event => setVerifiedClaim(event.target.checked ? job.claimId! : null)} />I verified the earlier worker has stopped</label>
        <Button size="sm" variant="outline" disabled={!!queue.action || verifiedClaim !== job.claimId} onClick={() => void queue.recoverOrphan?.(job)}>Release verified earlier worker</Button>
      </details> : null}
    </div>)}
    {queue.loading ? <PipelineRailSkeleton /> : <PipelineRunRail runs={queue.runs} observedAt={queue.observedAt} keepFinished progress={run => run.progress ?? queueProgress(run)}
      historyHref={resultsHref}
      renderHistory={run => {
        const { steps } = run.progress ?? queueProgress(run)
        const summary = plateOutcomeSummary(steps)
        return <>
          <p className="caption">{run.batchName ?? 'Batch'} · {requester?.(run.requestedBy) ?? run.requestedBy}</p>
          {summary && <p className="caption">{summary}</p>}
          <PopoverPrimitive.Close asChild><Button asChild size="sm" variant="ghost"><Link href={resultsHref(run)} prefetch={false}>View saved results</Link></Button></PopoverPrimitive.Close>
          {(run.status === 'cancelled' || run.status === 'failed' && run.dismissedAt !== undefined || run.status === 'completed' && run.attempts.at(-1)?.outcome === 'partial' && steps.some(step => step.status === 'failed')) && !run.jobs.some(job => job.state === 'claimed')
            ? <Button size="sm" variant="outline" disabled={!run.editable || !!queue.action} onClick={() => void queue.retry(run.id)}>Retry pending stages</Button>
            : null}
        </>
      }}
      renderRun={run => {
        const attempt = run.attempts.at(-1)!
        const unresolved = run.jobs.some(job => job.state === 'claimed')
        const canCancel = ['queued', 'running'].includes(run.status) && run.cancelRequestedAt === undefined
        const canDismiss = ['failed', 'completed', 'cancelled'].includes(run.status) && !unresolved
        const runAction = canCancel
          ? <Tooltip>
            <TooltipTrigger asChild><Button size="icon" className="size-8" variant="ghost" aria-label="Cancel remaining stages" disabled={!run.editable || !!queue.action} onClick={() => void queue.cancel(run.id)}><IoStopCircleOutline aria-hidden="true" /></Button></TooltipTrigger>
            <TooltipContent>Cancel remaining stages. Any active stage can finish, and saved drafts are kept.</TooltipContent>
          </Tooltip>
          : canDismiss
            ? <Tooltip>
              <TooltipTrigger asChild><Button size="icon" className="size-8" variant="ghost" aria-label="Remove run card" disabled={!!queue.action} onClick={() => void queue.dismiss(run.id)}><IoTrashOutline aria-hidden="true" /></Button></TooltipTrigger>
              <TooltipContent>Move this card to History. Saved drafts are kept.</TooltipContent>
            </Tooltip>
            : undefined
        return <PipelineRunCard run={run} stages={run.stages} progress={run.progress ?? queueProgress(run)} observedAt={queue.observedAt} requester={requester?.(run.requestedBy)} local
          runAction={runAction} waitLabel={run.queueWait ? queueWaitLabels[run.queueWait] : undefined}
          resultsHref={run.status === 'queued' || run.status === 'running' ? resultsHref(run) : undefined}>
          <details className={styles.activity}><summary>Run activity</summary><p>{run.status} · attempt {attempt.number} · Requested {new Date(run.createdAt).toLocaleString()}</p>{attempt.error ? <p>{attempt.error.replaceAll('_', ' ')}</p> : null}</details>
          <span className="caption mr-auto" role="status">{run.cancelRequestedAt !== undefined || run.waitReason === 'recovery' || run.waitReason === 'image_choice' ? label(run) : run.previewOnly ? 'Preview only' : !run.editable ? 'This Batch is read-only.' : ''}</span>
          <Button asChild size="sm" variant="ghost"><Link href={resultsHref(run)} prefetch={false}>View results</Link></Button>
          {(run.status === 'failed' || run.status === 'cancelled' || run.status === 'completed' && attempt.outcome === 'partial' && (run.progress ?? queueProgress(run)).steps.some(step => step.status === 'failed')) && !unresolved ? <Button size="sm" variant="outline" disabled={!run.editable || !!queue.action} onClick={() => void queue.retry(run.id)}>Retry pending stages</Button> : null}
        </PipelineRunCard>
      }} />}
  </section>
}
