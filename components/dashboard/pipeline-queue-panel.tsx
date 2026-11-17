'use client'

import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { editableFieldKeys } from '@/lib/review/fields'
import type { TaggingJob } from '@/lib/jobs/types'
import type { QueueRunView } from '@/lib/jobs/queue-types'
import type { usePipelineQueue } from './use-pipeline-queue'

type QueueControls = Pick<ReturnType<typeof usePipelineQueue>, 'runs' | 'selected' | 'select' | 'loading' | 'error' | 'refresh' | 'action' | 'message' | 'cancel' | 'retry' | 'apply' | 'chooseImage' | 'recover'> &
  Partial<Pick<ReturnType<typeof usePipelineQueue>, 'orphanJobs' | 'recoverOrphan'>>

function label(run: QueueRunView) {
  const attempt = run.attempts.at(-1)!
  if (run.cancelRequestedAt !== undefined && run.status === 'running') return 'Cancellation requested · waiting for the active stage to finish'
  if (run.waitReason === 'recovery') return 'Recovery needed · waiting for the worker to confirm it stopped'
  if (run.waitReason === 'image_choice') return 'Waiting for your image selection'
  if (attempt.outcome === 'no_result') return `No result · ${attempt.error?.replaceAll('_', ' ') ?? 'no supported suggestion'}`
  if (run.status === 'queued') return 'Queued · waiting for a local worker and available resources'
  return run.status[0].toUpperCase() + run.status.slice(1)
}

const show = (value: unknown) => value == null ? 'None' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)

export function PipelineQueuePanel({ queue, renderSpecialized }: { queue: QueueControls; renderSpecialized?(job: TaggingJob, run: QueueRunView): ReactNode }) {
  const [verifiedClaim, setVerifiedClaim] = useState<string | null>(null)
  const selected = queue.selected
  const attempt = selected?.attempts.at(-1)
  const entries = Object.values(attempt?.projection?.plates ?? {})
  const currentJob = selected?.jobs.find(job => job.queueAttempt === attempt?.number && job.queueStep === attempt.cursor)
  return <section aria-label="Pipeline queue and history" className="col-span-full grid basis-full gap-[var(--stack-gap)] rounded-[var(--radius-lg)] bg-[var(--card)] p-4 text-[var(--ink)]">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="label">Pipeline queue and history</h2>
      <Button size="sm" variant="ghost" onClick={() => void queue.refresh()}>Refresh queue</Button></div>
    {queue.loading ? <p role="status">Loading saved runs…</p> : null}
    {queue.error ? <p role="alert">Could not load saved runs. Refresh to try again.</p> : null}
    {!queue.loading && !queue.error && !queue.runs.length ? <p className="caption">Queued runs and their results will stay here after reload.</p> : null}
    {queue.message ? <p role="alert">{queue.message}</p> : null}
    {queue.orphanJobs?.map(job => <div key={job.id} className="grid gap-2 rounded-[var(--radius-md)] bg-[var(--fill)] p-3">
      <p role="status">Earlier local {job.stage ?? 'tag'} job · {job.inputPlate?.displayName ?? job.plateId} · {job.recoveryNeededAt !== undefined ? 'worker outcome unknown' : 'running'}</p>
      {job.recoveryNeededAt !== undefined ? <details><summary className="cursor-pointer">Recover earlier local worker</summary>
        <p className="caption">Verify worker {job.workerId} has stopped executing. Releasing its slot cannot stop it.</p>
        <label className="caption flex items-center gap-2"><input type="checkbox" checked={verifiedClaim === job.claimId} onChange={event => setVerifiedClaim(event.target.checked ? job.claimId! : null)} />I verified the earlier worker has stopped</label>
        <Button size="sm" variant="outline" disabled={!!queue.action || verifiedClaim !== job.claimId} onClick={() => void queue.recoverOrphan?.(job)}>Release verified earlier worker</Button>
      </details> : null}
    </div>)}
    <ol className="grid gap-[var(--stack-gap)]">{queue.runs.map(run => {
      const attempt = run.attempts.at(-1)!
      const unresolved = run.jobs.some(job => job.state === 'claimed')
      return <li key={run.id} className="grid gap-2 rounded-[var(--radius-md)] bg-[var(--fill)] p-3">
        <p><strong>{run.plateIds.length} plates · {run.stages.join(' → ')}</strong></p>
        <p className="caption" role="status">{label(run)} · {attempt.completedJobIds.length}/{attempt.steps.length} stages · attempt {attempt.number}{run.previewOnly ? ' · Preview only' : ''}</p>
        <p className="caption">Requested {new Date(run.createdAt).toLocaleString()} · Batch {run.batchId}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" aria-pressed={selected?.id === run.id} onClick={() => queue.select(run.id)}>View run {run.id.slice(0, 8)}</Button>
          {['queued', 'running'].includes(run.status) && run.cancelRequestedAt === undefined ? <Button size="sm" variant="ghost" disabled={!run.editable || !!queue.action} onClick={() => void queue.cancel(run.id)}>Cancel remaining stages</Button> : null}
          {['failed', 'cancelled'].includes(run.status) && !unresolved ? <Button size="sm" variant="outline" disabled={!run.editable || !!queue.action} onClick={() => void queue.retry(run.id)}>Retry pending stages</Button> : null}
        </div>
        {!run.editable ? <p className="caption">This Batch is read-only.</p> : null}
      </li>
    })}</ol>
    {selected ? <div className="grid gap-[var(--stack-gap)]">
      <div className="flex flex-wrap justify-between gap-2"><h3 className="label">Run {selected.id.slice(0, 8)} · coherent result</h3>
        <Button size="sm" variant="ghost" onClick={() => queue.select('none')}>Hide results</Button></div>
      <p className="caption">Review the connected changes together. Apply saves one draft edit bundle and checks the original Batch revisions.</p>
      {selected.waitReason === 'image_choice' && currentJob ? renderSpecialized?.(currentJob, selected) ?? <p role="status">Select an image candidate to continue this run.</p> : null}
      {entries.map(entry => {
        const fields = editableFieldKeys().filter(key => JSON.stringify(entry.batchInput[key]) !== JSON.stringify(entry.executionPlate[key]))
        return fields.length ? <details key={entry.batchInput.id} className="rounded-[var(--radius-md)] bg-[var(--fill)] p-3"><summary className="cursor-pointer">{entry.batchInput.displayName} · {fields.length} changed fields</summary>
          <dl className="mt-[var(--stack-gap)] grid gap-[var(--stack-gap)]">{fields.map(key => <div key={key} className="grid gap-2"><dt className="label">{key}</dt>
            <dd className="grid gap-2 sm:grid-cols-2"><div><span className="caption">Original Batch</span><pre className="whitespace-pre-wrap break-words font-sans text-sm">{show(entry.batchInput[key])}</pre></div>
              <div><span className="caption">Run suggestion</span><pre className="whitespace-pre-wrap break-words font-sans text-sm">{show(entry.executionPlate[key])}</pre></div></dd></div>)}</dl>
        </details> : null
      })}
      {selected.status === 'completed' ? <Button disabled={!selected.editable || selected.applied || !!queue.action} onClick={() => void queue.apply(selected.id)}>{selected.applied ? 'Saved to your Batch' : 'Apply coherent run to your Batch'}</Button> : null}
      {selected.waitReason === 'recovery' && currentJob?.claimId ? <details className="grid gap-2"><summary className="cursor-pointer">Recover a stopped worker</summary>
        <p className="caption">Verify that worker {currentJob.workerId} has stopped executing this stage. Releasing its slot cannot stop the worker.</p>
        <label className="caption flex items-center gap-2"><input type="checkbox" checked={verifiedClaim === currentJob.claimId} onChange={event => setVerifiedClaim(event.target.checked ? currentJob.claimId! : null)} />I verified this worker has stopped</label>
        <Button size="sm" variant="outline" disabled={!selected.editable || !!queue.action || verifiedClaim !== currentJob.claimId} onClick={() => void queue.recover(selected.id, currentJob.id, currentJob.claimId!)}>Release verified stopped worker</Button>
      </details> : null}
      <details><summary className="caption cursor-pointer">Attempt history</summary><ol className="mt-[var(--stack-gap)] grid gap-[var(--stack-gap)]">
        {selected.attempts.map(attempt => <li key={attempt.number} className="caption">Attempt {attempt.number} · {attempt.status}{attempt.error ? ` · ${attempt.error.replaceAll('_', ' ')}` : ''} · {attempt.completedJobIds.length}/{attempt.steps.length} stages</li>)}
      </ol></details>
    </div> : null}
  </section>
}
