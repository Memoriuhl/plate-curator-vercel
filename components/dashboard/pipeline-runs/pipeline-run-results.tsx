'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import Link from 'next/link'
import { Dialog } from 'radix-ui'
import { IoArrowBack, IoClose } from 'react-icons/io5'
import { FamilyCard } from '@/components/plate/family-card'
import { ReadyPlatePreview } from '@/components/plate/ready-plate-preview'
import type {
  PlateCardData,
  PlateCheckKey,
} from '@/lib/catalog/dashboard-types'
import { Button } from '@/components/ui/button'
import { JURISDICTIONS } from '@/lib/catalog/jurisdictions'
import type { Plate } from '@/lib/catalog/types'
import { batchHref, reviewHref } from '@/lib/review/href'
import { editableFieldKeys } from '@/lib/review/fields'
import type { EditableFields } from '@/lib/review/types'
import {
  plateOutcomes,
  plateOutcomeSummary,
  queueProgress,
} from '@/lib/jobs/run-progress'
import type { LocalRunStage, QueueRunView } from '@/lib/jobs/queue/queue-types'
import { pipelineStages, pipelineStepReason } from './pipeline-stages'
import { PipelineFieldValue, pipelineFieldLabel } from './pipeline-field-value'
import { EnhancedImageResult } from './enhanced-image-result'
import { SpecializedSuggestion } from '../specialized-suggestion'
import { usePipelineQueue } from './use-pipeline-queue'
import { PipelineResultsSkeleton } from './pipeline-results-skeleton'
import { runRevertTarget } from '@/lib/jobs/revert-target'
import { RunRevertButton } from '@/components/review/run-revert-button'
import { isSharedDraftId } from '@/lib/review/draft/draft-id'
import styles from './pipeline-results.module.css'

type ResultActions = Pick<
  ReturnType<typeof usePipelineQueue>,
  'action' | 'apply' | 'chooseImage' | 'recover'
>
type ResultCard = {
  id: string
  state: string
  content: ReactNode
  hasResult: boolean
  hasIssue: boolean
}

function StateResultLists({ cards }: { cards: ResultCard[] }) {
  const states = [...Map.groupBy(cards, (card) => card.state)]
    .map(([code, plates]) => ({
      code,
      name: JURISDICTIONS[code] ?? code,
      plates,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return (
    <>
      {states.map(({ code, name, plates }) => (
        <section key={code} className={styles.stateGroup}>
          <h3 className="label">{name}</h3>
          <ul
            className={`${styles.grid} ${styles.stateCards}`}
            aria-label={name}
          >
            {plates.map(({ id, content }) => (
              <li key={id} className="min-w-0">
                {content}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

type ResultPreview = {
  plate: PlateCardData
  anchor: HTMLElement
  immediate: boolean
  checkKey?: PlateCheckKey
}

/**
 * Give result cards the Dashboard's hover previews: the plate card on the image and a
 * tooltip on each check icon. Cards hold the plate as the run left it, so the previews
 * show the run's values instead of loading the saved plate.
 */
function useResultPreview() {
  const [preview, setPreview] = useState<ResultPreview | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const opened = useRef(false)
  useEffect(() => () => clearTimeout(timer.current), [])
  const close = useCallback(() => {
    clearTimeout(timer.current)
    setPreview(null)
  }, [])
  const leave = useCallback(() => {
    if (!opened.current) return close()
    clearTimeout(timer.current)
    timer.current = setTimeout(close, 230)
  }, [close])
  const open = (next: ResultPreview) => {
    clearTimeout(timer.current)
    opened.current = false
    if (next.anchor.isConnected) setPreview(next)
  }
  const cardProps = {
    onPreview: (
      plate: PlateCardData,
      anchor: HTMLElement,
      immediate: boolean
    ) => open({ plate, anchor, immediate }),
    onCheck: (
      plate: PlateCardData,
      checkKey: PlateCheckKey,
      anchor: HTMLElement
    ) => open({ plate, anchor, immediate: false, checkKey }),
    onClosePreview: leave,
    onDismissPreview: close,
    onLeaveCheck: () => (preview?.checkKey === 'image' ? leave() : close()),
  }
  const element = preview ? (
    <ReadyPlatePreview
      {...preview}
      localOnly
      onReady={() => {
        opened.current = true
      }}
      onMouseEnter={() => clearTimeout(timer.current)}
      onMouseLeave={leave}
    />
  ) : null
  return { cardProps, element }
}

function collectFields(
  target: Map<string, unknown>,
  fields: Partial<EditableFields>,
  input?: Plate
) {
  for (const field of editableFieldKeys()) {
    if (
      Object.hasOwn(fields, field) &&
      (!input || JSON.stringify(fields[field]) !== JSON.stringify(input[field]))
    )
      target.set(field, fields[field])
  }
}

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
  stage,
  byState,
}: {
  run: QueueRunView
  actions: ResultActions
  observedAt?: number
  stage?: LocalRunStage
  byState?: boolean
}) {
  const [verifiedClaim, setVerifiedClaim] = useState<string | null>(null)
  const hover = useResultPreview()
  const attempt = run.attempts.at(-1)!
  const progress = run.progress ?? queueProgress(run)
  const steps = stage
    ? progress.steps.filter((step) => step.stage === stage)
    : progress.steps
  const outcomes = plateOutcomes(steps)
  const summary = plateOutcomeSummary(steps)
  const cards = new Map(run.cards?.map((card) => [card.id, card]))
  const jobs = stage
    ? run.jobs.filter((job) => (job.stage ?? 'tag') === stage)
    : run.jobs
  const jobsByPlate = Map.groupBy(jobs, (job) => job.plateId)
  const entries = attempt.projection?.plates ?? {}
  const plateNames = Object.fromEntries(
    Object.values(entries).map((entry) => [
      entry.batchInput.id,
      entry.batchInput.displayName,
    ])
  )
  const plateDetails = new Map(run.plates?.map((plate) => [plate.id, plate]))
  const stepsByPlate = Map.groupBy(steps, (step) => step.plateId)
  const plateIds =
    stage && stage !== 'group'
      ? run.plateIds.filter((id) => stepsByPlate.has(id) || jobsByPlate.has(id))
      : run.plateIds
  const currentJob = run.jobs.find(
    (job) =>
      job.queueAttempt === attempt.number && job.queueStep === attempt.cursor
  )
  const leaseActive =
    currentJob?.leaseExpiresAt !== undefined &&
    (observedAt === undefined || currentJob.leaseExpiresAt > observedAt)
  const enhancementOnly = run.stages.every((stage) => stage === 'enhance-image')
  const saved = run.draftPlateIds?.length ?? 0
  const groupFields = new Map<
    string,
    { fields: Partial<EditableFields>; input?: Plate }
  >()
  if (byState && (!stage || stage === 'group'))
    for (const job of jobs) {
      const suggestion = job.result?.fieldSuggestion
      if (
        job.state !== 'completed' ||
        job.result?.stageError ||
        suggestion?.kind !== 'group'
      )
        continue
      const input = new Map(
        job.groupScope?.map((member) => [member.plate.id, member.plate])
      )
      for (const proposal of suggestion.proposals)
        groupFields.set(proposal.plateId, {
          fields: proposal.fields,
          input: input.get(proposal.plateId),
        })
    }

  const resultCards = plateIds.map((id) => {
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
    const group = groupFields.get(id)
    if (group) collectFields(reportedFields, group.fields, group.input)
    const specialized = (jobsByPlate.get(id) ?? []).filter((job) => {
      const suggestion = job.result?.fieldSuggestion
      if (job.state === 'completed' && job.result && !job.result.stageError) {
        if ((stage || run.incrementalDrafts) && suggestion?.kind === 'fields') {
          collectFields(
            reportedFields,
            suggestion.fields,
            byState ? job.inputPlate : undefined
          )
        }
        if (stage === 'tag' && job.result.suggestions.length) {
          const inputTags =
            byState && job.inputPlate
              ? new Set(
                  job.inputPlate.tags.map((tag) => tag.trim().toLowerCase())
                )
              : undefined
          if (
            !inputTags ||
            job.result.suggestions.some(
              (tag) => !inputTags.has(tag.trim().toLowerCase())
            )
          )
            reportedFields.set('tags', job.result.suggestions)
        }
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
        (!stage &&
          entry &&
          JSON.stringify(entry.batchInput[key]) !==
            JSON.stringify(entry.executionPlate[key]))
    )
    const reason = outcome?.step?.reason
    const outcomeStage =
      outcome?.step &&
      pipelineStages.find((item) => item.id === outcome.step?.stage)?.label
    const footer = (
      <div className={styles.cardFooter}>
        <div className={styles.cardCaption}>
          {pending && !outcome && <span className="caption">{pending}</span>}
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
                {outcomeStage && `${outcomeStage} · `}
                {reason === 'draft_conflict'
                  ? 'The saved draft changed during the run. Your edits were kept.'
                  : pipelineStepReason(reason)}
              </p>
            )}
            {changed.length > 0 && (
              <dl className={styles.fields}>
                {changed.map((key) => {
                  const value = reportedFields.has(key)
                    ? reportedFields.get(key)
                    : entry?.executionPlate[key]
                  const compare =
                    entry &&
                    JSON.stringify(entry.batchInput[key]) !==
                      JSON.stringify(stage ? value : entry.executionPlate[key])
                  return (
                    <div key={key} className={styles.field}>
                      <dt className="label">{pipelineFieldLabel(key)}</dt>
                      <dd className={compare ? styles.comparison : undefined}>
                        {compare && (
                          <div>
                            <span className="caption">Original Batch</span>
                            <PipelineFieldValue
                              field={key}
                              value={entry.batchInput[key]}
                              plateNames={plateNames}
                            />
                          </div>
                        )}
                        <div>
                          {compare && (
                            <span className="caption">Run suggestion</span>
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
              if (suggestion?.kind !== 'image' && suggestion?.kind !== 'group')
                return null
              const choice =
                run.waitReason === 'image_choice' && currentJob?.id === job.id
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
                    (suggestion.kind === 'image' && !!attempt.choices[job.id])
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
    return {
      id,
      state:
        card?.state ??
        entry?.batchInput.state ??
        plateDetails.get(id)?.state ??
        plateSteps?.[0]?.plateState ??
        id.split('.')[0],
      content: card ? (
        <FamilyCard
          template={card}
          variants={[]}
          browseOnly
          footer={footer}
          {...hover.cardProps}
        />
      ) : (
        <article className="rounded-[var(--radius-lg)] bg-[var(--card)] p-4">
          <h3 className="plate-name">{name}</h3>
          {footer}
        </article>
      ),
      hasResult:
        changed.length > 0 ||
        specialized.some(
          (job) =>
            job.state === 'completed' &&
            !job.result?.stageError &&
            job.result?.fieldSuggestion?.kind !== 'group'
        ),
      hasIssue: !!reason,
    }
  })
  const results = byState
    ? resultCards.filter((card) => card.hasResult)
    : resultCards
  const issues = byState
    ? resultCards.filter((card) => card.hasIssue && !card.hasResult)
    : []

  return (
    <>
      <div className={styles.summary}>
        <p className="caption">
          {results.length} {results.length === 1 ? 'plate' : 'plates'}
          {byState && ' with results'}
          {summary && ` · ${summary}`}
          {run.previewOnly
            ? ' · Preview only'
            : !stage && run.incrementalDrafts && saved > 0
              ? ` · ${saved} saved to ${run.batchName ?? 'your Batch'}`
              : ''}
        </p>
        {run.editable &&
          isSharedDraftId(run.batchId) &&
          (saved > 0 || run.applied) &&
          !run.previewOnly &&
          run.status !== 'queued' &&
          run.status !== 'running' &&
          attempt.jobIds && (
            <RunRevertButton
              key={`${run.id}:${attempt.number}`}
              runId={run.id}
              target={runRevertTarget({
                number: attempt.number,
                jobIds: attempt.jobIds,
              })}
            />
          )}
        {!stage && run.incrementalDrafts && !enhancementOnly && (
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
        {!stage &&
          !enhancementOnly &&
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
      {byState ? (
        <>
          {results.length ? (
            <StateResultLists cards={results} />
          ) : (
            <p className="caption">No plate changes for this stage.</p>
          )}
          {issues.length > 0 && (
            <details className={styles.otherOutcomes}>
              <summary className="caption cursor-pointer">
                Other outcomes ({issues.length})
              </summary>
              <StateResultLists cards={issues} />
            </details>
          )}
        </>
      ) : (
        <ul className={styles.grid} aria-label="Plates in this run">
          {results.map(({ id, content }) => (
            <li key={id} className="min-w-0">
              {content}
            </li>
          ))}
        </ul>
      )}
      {run.waitReason === 'recovery' &&
        currentJob?.claimId &&
        (!stage || (currentJob.stage ?? 'tag') === stage) && (
          <details className="grid gap-2">
            <summary className="caption cursor-pointer">
              Recover a stopped worker
            </summary>
            <p className="caption">
              Confirm that {currentJob.workerId} has stopped executing this
              stage.
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
      {hover.element}
    </>
  )
}

function QueueRunResults({
  queue,
  stage,
  byState,
}: {
  queue: ReturnType<typeof usePipelineQueue>
  stage?: LocalRunStage
  byState?: boolean
}) {
  return (
    <>
      {queue.message && (
        <p role="alert" className="caption">
          {queue.message}
        </p>
      )}
      {queue.loading && !queue.selected && (
        <PipelineResultsSkeleton stacked={byState} />
      )}
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
      {!queue.loading && !queue.error && !queue.selected && (
        <p>Run results are unavailable.</p>
      )}
      {queue.selected && (
        <PipelineRunResults
          run={queue.selected}
          actions={queue}
          observedAt={queue.observedAt}
          stage={stage}
          byState={byState}
        />
      )}
    </>
  )
}

export function PipelineDrawerRunResults({
  runId,
  stage,
  active,
  backRef,
  onBack,
}: {
  runId: string
  stage: LocalRunStage
  active: boolean
  backRef: RefObject<HTMLButtonElement | null>
  onBack: () => void
}) {
  const queue = usePipelineQueue(undefined, undefined, runId, active)
  const stageLabel =
    pipelineStages.find((item) => item.id === stage)?.label ?? stage
  return (
    <section
      className={styles.drawerResults}
      aria-label={`${stageLabel} results`}
    >
      <header className={styles.drawerHeader}>
        <Button
          ref={backRef}
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Back to runs"
          onClick={onBack}
        >
          <IoArrowBack aria-hidden="true" />
          Runs
        </Button>
        <div>
          <h2 className="page-title">{stageLabel} results</h2>
          <p className="caption">
            {queue.selected?.batchName && `${queue.selected.batchName} · `}Run{' '}
            {runId.slice(-8)}
          </p>
        </div>
      </header>
      <QueueRunResults queue={queue} stage={stage} byState />
    </section>
  )
}

export function PipelineRunResultsPage({
  runId,
  stage,
}: {
  runId: string
  stage?: string
}) {
  const queue = usePipelineQueue(undefined, undefined, runId)
  const run = queue.selected
  const selectedStage = run?.stages.find((value) => value === stage)
  const stageLabel =
    selectedStage &&
    (pipelineStages.find((item) => item.id === selectedStage)?.label ??
      selectedStage)
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
          <h1 className="page-title">
            {stageLabel ? `${stageLabel} results` : 'Run results'}
          </h1>
          <p className="caption">
            {run?.batchName && `${run.batchName} · `}Run {runId.slice(-8)}
          </p>
        </div>
        {run && selectedStage && (
          <Button asChild size="sm" variant="ghost">
            <Link
              href={batchHref(
                `/pipeline/runs/${encodeURIComponent(run.id)}`,
                run.batchId
              )}
            >
              All run results
            </Link>
          </Button>
        )}
      </header>
      <QueueRunResults queue={queue} stage={selectedStage} />
    </main>
  )
}
