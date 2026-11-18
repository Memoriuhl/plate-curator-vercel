'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Dialog } from 'radix-ui'
import { IoArrowBack, IoClose } from 'react-icons/io5'
import { FamilyCard } from '@/components/plate/family-card'
import { Button } from '@/components/ui/button'
import { batchHref, reviewHref } from '@/lib/review/href'
import { editableFieldKeys } from '@/lib/review/fields'
import {
  plateOutcomes,
  plateOutcomeSummary,
  queueProgress,
} from '@/lib/jobs/run-progress'
import type { QueueRunView } from '@/lib/jobs/queue-types'
import { pipelineStages, pipelineStepReason } from './pipeline-stages'
import { PipelineFieldValue, pipelineFieldLabel } from './pipeline-field-value'
import { EnhancedImageResult } from './enhanced-image-result'
import { SpecializedSuggestion } from './specialized-suggestion'
import { usePipelineQueue } from './use-pipeline-queue'
import styles from './pipeline-results.module.css'

type ResultActions = Pick<
  ReturnType<typeof usePipelineQueue>,
  'action' | 'apply' | 'chooseImage' | 'recover'
>

function ResultDetail({
  name,
  plateId,
  children,
}: {
  name: string
  plateId: string
  children: ReactNode
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`View changes for ${name}`}
        >
          View changes
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.detail} aria-describedby={undefined}>
          <header className={styles.detailHeader}>
            <Dialog.Title className="plate-name min-w-0 break-words">
              {name}
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Close plate changes"
              >
                <IoClose aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </header>
          <div
            className={styles.detailBody}
            aria-label={`Changes for ${plateId}`}
          >
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function PipelineRunResults({
  run,
  actions,
  observedAt,
}: {
  run: QueueRunView
  actions: ResultActions
  observedAt?: number
}) {
  const [verifiedClaim, setVerifiedClaim] = useState<string | null>(null)
  const attempt = run.attempts.at(-1)!
  const { steps } = run.progress ?? queueProgress(run)
  const outcomes = plateOutcomes(steps)
  const summary = plateOutcomeSummary(steps)
  const cards = new Map(run.cards?.map((card) => [card.id, card]))
  const jobsByPlate = Map.groupBy(run.jobs, (job) => job.plateId)
  const entries = attempt.projection?.plates ?? {}
  const plateNames = Object.fromEntries(
    Object.values(entries).map((entry) => [
      entry.batchInput.id,
      entry.batchInput.displayName,
    ])
  )
  const plateDetails = new Map(run.plates?.map((plate) => [plate.id, plate]))
  const stepsByPlate = Map.groupBy(steps, (step) => step.plateId)
  const currentJob = run.jobs.find(
    (job) =>
      job.queueAttempt === attempt.number && job.queueStep === attempt.cursor
  )
  const leaseActive =
    currentJob?.leaseExpiresAt !== undefined &&
    (observedAt === undefined || currentJob.leaseExpiresAt > observedAt)
  const enhancementOnly = run.stages.every((stage) => stage === 'enhance-image')
  const saved = run.draftPlateIds?.length ?? 0

  return (
    <>
      <div className={styles.summary}>
        <p className="caption">
          {run.plateIds.length} {run.plateIds.length === 1 ? 'plate' : 'plates'}
          {summary && ` · ${summary}`}
          {run.previewOnly
            ? ' · Preview only'
            : run.incrementalDrafts && saved > 0
              ? ` · ${saved} saved to ${run.batchName ?? 'your Batch'}`
              : ''}
        </p>
        {run.incrementalDrafts && !enhancementOnly && (
          <Button asChild size="sm" variant="publish">
            <Link
              href={reviewHref(undefined, undefined, run.batchId, {
                run: run.id,
              })}
            >
              Review run changes
            </Link>
          </Button>
        )}
        {!enhancementOnly &&
          !run.incrementalDrafts &&
          run.status === 'completed' &&
          attempt.outcome !== 'no_result' &&
          !run.previewOnly && (
            <Button
              size="sm"
              disabled={!run.editable || run.applied || !!actions.action}
              onClick={() => void actions.apply(run.id)}
            >
              {run.applied
                ? 'Saved to your Batch'
                : 'Apply coherent run to your Batch'}
            </Button>
          )}
      </div>
      {run.previewOnly && !enhancementOnly && (
        <p className="caption">
          Run again without Preview only to apply changes.
        </p>
      )}
      <ul className={styles.grid} aria-label="Plates in this run">
        {run.plateIds.map((id) => {
          const card = cards.get(id)
          const entry = entries[id]
          const outcome = outcomes.get(id)
          const plateSteps = stepsByPlate.get(id)
          const name =
            card?.displayName ??
            entry?.batchInput.displayName ??
            plateDetails.get(id)?.displayName ??
            plateSteps?.[0]?.plateName ??
            id
          const pending = plateSteps?.some((step) => step.status === 'waiting')
            ? 'Choose image'
            : plateSteps?.some((step) => step.status === 'running')
              ? 'Running'
              : plateSteps?.some((step) => step.status === 'queued')
                ? 'Waiting'
                : undefined
          // Incremental saves move the projection forward. The original job results still record the suggestions.
          const reportedFields = new Map<string, unknown>()
          const specialized = (jobsByPlate.get(id) ?? []).filter((job) => {
            const suggestion = job.result?.fieldSuggestion
            if (
              run.incrementalDrafts &&
              job.state === 'completed' &&
              suggestion?.kind === 'fields'
            ) {
              for (const [field, value] of Object.entries(suggestion.fields))
                reportedFields.set(field, value)
            }
            return (
              suggestion?.kind === 'image' ||
              suggestion?.kind === 'enhanced-image' ||
              suggestion?.kind === 'group'
            )
          })
          const changed = editableFieldKeys().filter(
            (key) =>
              reportedFields.has(key) ||
              (entry &&
                JSON.stringify(entry.batchInput[key]) !==
                  JSON.stringify(entry.executionPlate[key]))
          )
          const reason = outcome?.step?.reason
          const stage =
            outcome?.step &&
            pipelineStages.find((item) => item.id === outcome.step?.stage)
              ?.label
          const footer = (
            <div className={styles.cardFooter}>
              <div className={styles.cardCaption}>
                {pending && !outcome && (
                  <span className="caption">{pending}</span>
                )}
                {outcome && (
                  <span className={styles.outcome} data-outcome={outcome.label}>
                    {outcome.label}
                  </span>
                )}
                {changed.slice(0, 3).map((field) => (
                  <span key={field} className="caption">
                    {pipelineFieldLabel(field)}
                  </span>
                ))}
                {changed.length > 3 && (
                  <span className="caption">+{changed.length - 3}</span>
                )}
              </div>
              {(changed.length > 0 || reason || specialized.length > 0) && (
                <ResultDetail name={name} plateId={id}>
                  {reason && (
                    <p
                      className="caption"
                      role={reason === 'draft_conflict' ? 'alert' : undefined}
                    >
                      {stage && `${stage} · `}
                      {reason === 'draft_conflict'
                        ? 'The saved draft changed during the run. Your edits were kept.'
                        : pipelineStepReason(reason)}
                    </p>
                  )}
                  {changed.length > 0 && (
                    <dl className={styles.fields}>
                      {changed.map((key) => {
                        const compare =
                          entry &&
                          JSON.stringify(entry.batchInput[key]) !==
                            JSON.stringify(entry.executionPlate[key])
                        const value = reportedFields.has(key)
                          ? reportedFields.get(key)
                          : entry?.executionPlate[key]
                        return (
                          <div key={key} className={styles.field}>
                            <dt className="label">{pipelineFieldLabel(key)}</dt>
                            <dd
                              className={
                                compare ? styles.comparison : undefined
                              }
                            >
                              {compare && (
                                <div>
                                  <span className="caption">
                                    Original Batch
                                  </span>
                                  <PipelineFieldValue
                                    field={key}
                                    value={entry.batchInput[key]}
                                    plateNames={plateNames}
                                  />
                                </div>
                              )}
                              <div>
                                {compare && (
                                  <span className="caption">
                                    Run suggestion
                                  </span>
                                )}
                                <PipelineFieldValue
                                  field={key}
                                  value={value}
                                  plateNames={plateNames}
                                />
                              </div>
                            </dd>
                          </div>
                        )
                      })}
                    </dl>
                  )}
                  {specialized.map((job) => {
                    const suggestion = job.result?.fieldSuggestion
                    if (suggestion?.kind === 'enhanced-image') {
                      const source = job.inputPlate?.imageUrl
                      return (
                        <EnhancedImageResult
                          key={job.id}
                          jobId={job.id}
                          suggestion={suggestion}
                          plateName={name}
                          before={
                            typeof source === 'string'
                              ? source
                              : (card?.imageUrl ?? undefined)
                          }
                        />
                      )
                    }
                    if (
                      suggestion?.kind !== 'image' &&
                      suggestion?.kind !== 'group'
                    )
                      return null
                    const choice =
                      run.waitReason === 'image_choice' &&
                      currentJob?.id === job.id
                    return (
                      <SpecializedSuggestion
                        key={job.id}
                        suggestion={suggestion}
                        plates={Object.values(entries).map(
                          (entry) => entry.batchInput
                        )}
                        previewOnly={run.previewOnly}
                        blocked={!!actions.action || !choice || !run.editable}
                        accepted={
                          run.applied ||
                          (suggestion.kind === 'image' &&
                            !!attempt.choices[job.id])
                        }
                        selectedCandidateId={attempt.choices[job.id]}
                        {...(suggestion.kind === 'image'
                          ? {
                              onSelectImage: async (candidateId: string) => {
                                if (
                                  !(await actions.chooseImage(
                                    run.id,
                                    job.id,
                                    candidateId
                                  ))
                                )
                                  throw Error('Image choice was not saved')
                              },
                            }
                          : {})}
                      />
                    )
                  })}
                </ResultDetail>
              )}
            </div>
          )
          return (
            <li key={id} className="min-w-0">
              {card ? (
                <FamilyCard
                  template={card}
                  variants={[]}
                  browseOnly
                  footer={footer}
                />
              ) : (
                <article className="rounded-[var(--radius-lg)] bg-[var(--card)] p-4">
                  <h3 className="plate-name">{name}</h3>
                  {footer}
                </article>
              )}
            </li>
          )
        })}
      </ul>
      {run.waitReason === 'recovery' && currentJob?.claimId && (
        <details className="grid gap-2">
          <summary className="caption cursor-pointer">
            Recover a stopped worker
          </summary>
          <p className="caption">
            Confirm that {currentJob.workerId} has stopped executing this stage.
          </p>
          <label className="caption flex items-center gap-2">
            <input
              type="checkbox"
              checked={verifiedClaim === currentJob.claimId}
              onChange={(event) =>
                setVerifiedClaim(
                  event.currentTarget.checked ? currentJob.claimId! : null
                )
              }
            />
            I verified this worker has stopped
          </label>
          {leaseActive && (
            <p className="caption">Wait for the active lease to expire.</p>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={
              !!actions.action ||
              verifiedClaim !== currentJob.claimId ||
              leaseActive
            }
            onClick={() =>
              void actions.recover(run.id, currentJob.id, currentJob.claimId!)
            }
          >
            Release verified stopped worker
          </Button>
        </details>
      )}
    </>
  )
}

export function PipelineRunResultsPage({ runId }: { runId: string }) {
  const queue = usePipelineQueue(undefined, undefined, runId)
  const run = queue.selected
  const state = run?.plateIds[0]?.split('.')[0]
  const dashboard =
    state && run
      ? batchHref(`/states/${encodeURIComponent(state)}`, run.batchId)
      : '/'
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Button asChild size="sm" variant="ghost">
          <Link href={dashboard}>
            <IoArrowBack aria-hidden="true" />
            Dashboard
          </Link>
        </Button>
        <div>
          <h1 className="page-title">Run results</h1>
          <p className="caption">
            {run?.batchName && `${run.batchName} · `}Run {runId.slice(-8)}
          </p>
        </div>
      </header>
      {queue.message && (
        <p role="alert" className="caption">
          {queue.message}
        </p>
      )}
      {queue.loading && <p role="status">Loading run results…</p>}
      {queue.error && (
        <p role="alert">
          Could not load run results.{' '}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void queue.refresh()}
          >
            Try again
          </Button>
        </p>
      )}
      {!queue.loading && !queue.error && !run && (
        <p>Run results are unavailable.</p>
      )}
      {run && (
        <PipelineRunResults
          run={run}
          actions={queue}
          observedAt={queue.observedAt}
        />
      )}
    </main>
  )
}
