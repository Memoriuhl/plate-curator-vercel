import Image from 'next/image'
import Link from 'next/link'
import {
  IoArrowForward,
  IoCheckmark,
  IoChevronForward,
  IoClose,
  IoImageOutline,
  IoRemove,
} from 'react-icons/io5'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { dashboardPlateHref } from '@/lib/review/href'
import type { StepProgress } from '@/lib/jobs/run-progress'
import { pipelineStages, pipelineStepReason } from './pipeline-stages'
import styles from './pipeline-runs.module.css'

const statusLabels = {
  queued: 'Waiting',
  waiting: 'Needs input',
  running: 'Running',
  completed: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
}

function phaseStatus(
  step: StepProgress,
  index: number,
  length: number
): StepProgress['status'] {
  if (
    step.status === 'completed' ||
    step.status === 'skipped' ||
    step.status === 'cancelled' ||
    step.status === 'queued'
  )
    return step.status
  const cursor = step.phaseIndex ?? (step.status === 'waiting' ? length - 1 : 0)
  return index < cursor
    ? 'completed'
    : index === cursor
      ? step.status
      : step.status === 'failed'
        ? 'skipped'
        : 'queued'
}

export function PlatePipelineTimeline({
  steps,
  batchId,
  images,
}: {
  steps: StepProgress[]
  batchId?: string
  images?: Record<string, string>
}) {
  const rows = Map.groupBy(
    steps.filter((step) => step.stage !== 'group'),
    (step) => step.plateId
  )
  if (!rows.size) return null

  return (
    <section
      aria-label="Pipeline steps by plate"
      data-pipeline-watch-steps
      tabIndex={0}
      className={styles.watchTimeline}
    >
      <TooltipProvider delayDuration={250}>
        {[...rows].map(([plateId, plateSteps]) => {
          const { plateName, plateState } = plateSteps[0]
          const state =
            plateState ?? (plateId.includes('.') ? plateId.split('.')[0] : null)
          const image = images?.[plateId]
          return (
            <div key={plateId} className={styles.timelineRow}>
              <div className="flex min-w-0 items-center gap-1.5">
                {image ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="grid size-7 shrink-0 place-items-center rounded-sm focus-visible:outline-2"
                        aria-label={`Preview ${plateName} plate`}
                      >
                        <IoImageOutline aria-hidden="true" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent
                      collisionPadding={12}
                      className="max-w-[calc(100vw-24px)] p-2"
                    >
                      <Image
                        src={image}
                        width={240}
                        height={120}
                        alt={`${plateName} plate`}
                        className="h-auto w-60 max-w-full object-contain"
                        unoptimized
                      />
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <IoImageOutline
                    className="mx-1 shrink-0 text-[var(--ink-3)]"
                    aria-hidden="true"
                  />
                )}
                <strong className="caption truncate" title={plateName}>
                  {plateName}
                </strong>
                {state && (
                  <Link
                    href={dashboardPlateHref(state, plateId, batchId)}
                    prefetch={false}
                    scroll={false}
                    className="grid size-7 shrink-0 place-items-center rounded-sm hover:bg-muted focus-visible:outline-2"
                    aria-label={`Go to ${plateName} on the dashboard`}
                    title="Go to plate on the dashboard"
                  >
                    <IoArrowForward aria-hidden="true" />
                  </Link>
                )}
              </div>
              <ol
                aria-label={`${plateSteps[0].plateName} pipeline steps`}
                className="flex w-max items-center gap-1.5"
              >
                {plateSteps.flatMap((step, stageIndex) => {
                  const stage = pipelineStages.find(
                    (item) => item.id === step.stage
                  )
                  const phases = stage?.flow ?? [
                    { label: stage?.label ?? step.stage, icon: stage?.icon },
                  ]
                  return phases.map(({ label, icon: Icon }, index) => {
                    const status = phaseStatus(step, index, phases.length)
                    const reason =
                      status === 'failed' || step.status === 'skipped'
                        ? step.reason
                        : undefined
                    return (
                      <li
                        key={`${step.index}-${index}`}
                        className="inline-flex items-center gap-1.5"
                      >
                        {stageIndex || index ? (
                          <IoChevronForward
                            aria-hidden="true"
                            className="size-3 text-[var(--ink-2)]"
                          />
                        ) : null}
                        <span
                          className={styles.phase}
                          data-status={status}
                          aria-current={
                            status === 'running' ? 'step' : undefined
                          }
                          title={
                            reason
                              ? pipelineStepReason(reason)
                              : statusLabels[status]
                          }
                        >
                          {status === 'running' ? (
                            <span
                              aria-hidden="true"
                              className="size-3 shrink-0 rounded-full border border-[var(--warning)] border-r-transparent motion-safe:animate-spin"
                            />
                          ) : status === 'completed' ? (
                            <IoCheckmark
                              aria-hidden="true"
                              className="size-3 text-[var(--success)]"
                            />
                          ) : status === 'failed' ? (
                            <IoClose aria-hidden="true" className="size-3" />
                          ) : status === 'skipped' || status === 'cancelled' ? (
                            <IoRemove aria-hidden="true" className="size-3" />
                          ) : Icon ? (
                            <Icon aria-hidden="true" className="size-3" />
                          ) : null}
                          {label}
                          <span className="sr-only">
                            {' '}
                            {statusLabels[status]}
                          </span>
                        </span>
                      </li>
                    )
                  })
                })}
              </ol>
            </div>
          )
        })}
      </TooltipProvider>
    </section>
  )
}
