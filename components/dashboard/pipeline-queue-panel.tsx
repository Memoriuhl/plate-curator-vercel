'use client'

import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { editableFieldKeys } from '@/lib/review/fields'
import type { TaggingJob } from '@/lib/jobs/types'
import type { QueueRunSummary, QueueRunView } from '@/lib/jobs/queue-types'
import type { usePipelineQueue } from './use-pipeline-queue'
import { PipelineFieldValue, pipelineFieldLabel } from './pipeline-field-value'
import { PipelineRunCard } from './pipeline-run-card'
import { queueProgress } from '@/lib/jobs/run-progress'
import styles from './pipeline-runs.module.css'
import { SpecializedSuggestion } from './specialized-suggestion'

type QueueControls = Pick<ReturnType<typeof usePipelineQueue>, 'runs' | 'selected' | 'select' | 'loading' | 'error' | 'refresh' | 'action' | 'message' | 'cancel' | 'retry' | 'apply' | 'chooseImage' | 'recover'> &
  Partial<Pick<ReturnType<typeof usePipelineQueue>, 'orphanJobs' | 'recoverOrphan' | 'observedAt'>>

function label(run: QueueRunSummary) {
  const attempt = run.attempts.at(-1)!
  if (run.cancelRequestedAt !== undefined && run.status === 'running') return 'Cancellation requested · waiting for the active stage to finish'
  if (run.waitReason === 'recovery') return 'Recovery needed · waiting for the worker to confirm it stopped'
  if (run.waitReason === 'image_choice') return 'Waiting for your image selection'
  if (attempt.outcome === 'no_result') return `Failed · ${attempt.error?.replaceAll('_', ' ') ?? 'no supported suggestion'}`
  if (attempt.outcome === 'partial') return 'Completed with gaps'
  if (run.status === 'queued') return 'Queued · waiting for a local worker and available resources'
  return run.status[0].toUpperCase() + run.status.slice(1)
}

export function PipelineQueuePanel({ queue, renderSpecialized, header, requester }: { queue: QueueControls; header?: ReactNode; requester?(uid: string): string | undefined; renderSpecialized?(job: TaggingJob, run: QueueRunView): ReactNode }) {
  const [verifiedClaim, setVerifiedClaim] = useState<string | null>(null)
  const selected = queue.selected
  const attempt = selected?.attempts.at(-1)
  const entries = Object.values(attempt?.projection?.plates ?? {})
  const plateNames = Object.fromEntries(entries.map(entry => [entry.batchInput.id, entry.batchInput.displayName]))
  const currentJob = selected?.jobs.find(job => job.queueAttempt === attempt?.number && job.queueStep === attempt?.cursor)
  const leaseActive = currentJob?.leaseExpiresAt !== undefined && (queue.observedAt === undefined || currentJob.leaseExpiresAt > queue.observedAt)
  return <section aria-label="Pipeline queue and history" className={styles.panel}>
    {header ?? <h2 className="sr-only">Pipeline queue and history</h2>}
    {queue.error ? <Button size="sm" variant="ghost" onClick={() => void queue.refresh()}>Refresh queue</Button> : null}
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
      return <li key={run.id} className="min-w-0"><PipelineRunCard run={run} stages={run.stages} progress={run.progress ?? queueProgress(run)} observedAt={queue.observedAt} requester={requester?.(run.requestedBy)}>
        <span className="caption mr-auto" role="status">{run.cancelRequestedAt !== undefined || run.waitReason === 'recovery' || run.waitReason === 'image_choice' ? label(run) : run.previewOnly ? 'Preview only' : !run.editable ? 'This Batch is read-only.' : ''}</span>
        <Button size="sm" variant="ghost" aria-pressed={selected?.id === run.id} onClick={() => queue.select(run.id)}>View results</Button>
        {['queued', 'running'].includes(run.status) && run.cancelRequestedAt === undefined ? <Button size="sm" variant="ghost" disabled={!run.editable || !!queue.action} onClick={() => void queue.cancel(run.id)}>Cancel remaining stages</Button> : null}
        {['failed', 'cancelled'].includes(run.status) && !unresolved ? <Button size="sm" variant="outline" disabled={!run.editable || !!queue.action} onClick={() => void queue.retry(run.id)}>Retry pending stages</Button> : null}
        <details className={styles.activity}><summary>Run activity</summary><p>{run.status} · attempt {attempt.number} · Requested {new Date(run.createdAt).toLocaleString()} · {run.batchName ?? 'Batch'}</p>{attempt.error ? <p>{attempt.error.replaceAll('_', ' ')}</p> : null}</details>
      </PipelineRunCard></li>
    })}</ol>
    {selected ? <div className="grid gap-[var(--stack-gap)]">
      <div className="flex flex-wrap justify-between gap-2"><h3 className="label">Coherent run result</h3>
        <Button size="sm" variant="ghost" onClick={() => queue.select('none')}>Hide results</Button></div>
      <p className="caption">{selected.previewOnly ? 'Preview only: inspect these results. Run again without Preview only to apply changes.' : 'Review the connected changes together. Apply saves one draft edit bundle and checks the original Batch revisions.'}</p>
      {selected.jobs.filter(job => job.result?.fieldSuggestion?.kind === 'image' || job.result?.fieldSuggestion?.kind === 'group').map(job => {
        const suggestion = job.result!.fieldSuggestion!
        if (suggestion.kind === 'fields') return null
        const choice = selected.waitReason === 'image_choice' && currentJob?.id === job.id
        const plate = attempt?.projection?.plates[job.plateId]?.batchInput ?? job.inputPlate
        return <div key={job.id} className="grid gap-[var(--stack-gap)]">{suggestion.kind === 'image' ? <h4 className="label">Image for {plateNames[job.plateId] ?? job.inputPlate?.displayName ?? job.plateId}{plate?.state ? ` · ${plate.state}` : ''}</h4> : null}{renderSpecialized?.(job, selected) ?? <SpecializedSuggestion suggestion={suggestion} plates={entries.map(entry => entry.batchInput)}
          previewOnly={selected.previewOnly} blocked={!!queue.action || !choice || !selected.editable} accepted={selected.applied || suggestion.kind === 'image' && !!attempt?.choices[job.id]}
          selectedCandidateId={attempt?.choices[job.id]}
          {...(suggestion.kind === 'image' ? { onSelectImage: async (candidateId: string) => { if (!await queue.chooseImage(selected.id, job.id, candidateId)) throw Error('Image choice was not saved') } } : {})} />}</div>
      })}
      {entries.map(entry => {
        const fields = editableFieldKeys().filter(key => JSON.stringify(entry.batchInput[key]) !== JSON.stringify(entry.executionPlate[key]))
        return fields.length ? <details key={entry.batchInput.id} className="rounded-[var(--radius-md)] bg-[var(--fill)] p-3"><summary className="cursor-pointer">{entry.batchInput.displayName} · {fields.length} changed fields</summary>
          <dl className="mt-[var(--stack-gap)] grid gap-[var(--stack-gap)]">{fields.map(key => <div key={key} className="grid gap-2"><dt className="label">{pipelineFieldLabel(key)}</dt>
            <dd className="grid gap-2 sm:grid-cols-2"><div><span className="caption">Original Batch</span><PipelineFieldValue field={key} value={entry.batchInput[key]} plateNames={plateNames} /></div>
              <div><span className="caption">Run suggestion</span><PipelineFieldValue field={key} value={entry.executionPlate[key]} plateNames={plateNames} /></div></dd></div>)}</dl>
        </details> : null
      })}
      {selected.status === 'completed' && attempt?.outcome !== 'no_result' && !selected.previewOnly ? <Button disabled={!selected.editable || selected.applied || !!queue.action} onClick={() => void queue.apply(selected.id)}>{selected.applied ? 'Saved to your Batch' : 'Apply coherent run to your Batch'}</Button> : null}
      {selected.waitReason === 'recovery' && currentJob?.claimId ? <details className="grid gap-2"><summary className="cursor-pointer">Recover a stopped worker</summary>
        <p className="caption">Verify that worker {currentJob.workerId} has stopped executing this stage. Releasing its slot cannot stop the worker.</p>
        <label className="caption flex items-center gap-2"><input type="checkbox" checked={verifiedClaim === currentJob.claimId} onChange={event => setVerifiedClaim(event.target.checked ? currentJob.claimId! : null)} />I verified this worker has stopped</label>
        {leaseActive ? <p className="caption">The active lease has not expired. Wait for the worker to finish or for stale-claim recovery to become available.</p> : null}
        <Button size="sm" variant="outline" disabled={!!queue.action || verifiedClaim !== currentJob.claimId || leaseActive} onClick={() => void queue.recover(selected.id, currentJob.id, currentJob.claimId!)}>Release verified stopped worker</Button>
      </details> : null}
      <details><summary className="caption cursor-pointer">Attempt history</summary><p className="caption mt-[var(--stack-gap)] break-all">Run reference: {selected.id}</p><ol className="mt-[var(--stack-gap)] grid gap-[var(--stack-gap)]">
        {selected.attempts.map(attempt => <li key={attempt.number} className="caption">Attempt {attempt.number} · {attempt.status}{attempt.error ? ` · ${attempt.error.replaceAll('_', ' ')}` : ''} · {attempt.completedJobIds.length}/{attempt.steps.length} stages<p className="break-all">Job references: {attempt.jobIds.join(', ') || 'No stages started'}</p></li>)}
      </ol></details>
    </div> : null}
  </section>
}
