'use client'

import { useSelectedPlates } from './selection/plate-selection'
import { selectionActions } from './selection/selection-actions'
import { useEffect, useMemo, useRef, useState } from 'react'
import { IoChevronDown, IoPlay } from 'react-icons/io5'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/components/utils'
import {
  TaggingModelPicker,
  useTaggingModelChoice,
} from './tagging/tagging-model-picker'
import type { ModelOptions } from '@/lib/models/selection'
import type { RunPlate } from './tagging/use-tag-run'
import { localStageReasons, planTagRun } from './local-pipeline'
import type { PipelineStage } from '@/lib/jobs/types'
import { LOCAL_STAGE_DEFINITIONS } from '@/lib/jobs/stages'
import { PipelineRunControls } from './pipeline-runs/pipeline-run-controls'
import { onlyUnderTaggedLabel } from './pipeline-runs/pipeline-stages'
import type { usePipelineQueue } from './use-pipeline-queue'
import type { ComponentProps } from 'react'
import {
  estimateStageMs,
  formatEstimate,
  useRunTimings,
} from './pipeline-runs/pipeline-estimates'

const stages = [
  [
    'Find image',
    'Search for a clean plate photo',
    'Only plates missing an image',
  ],
  ['Wiki link', 'Match a Wikipedia or DMV page'],
  ['Colors', 'Background and text colours'],
  ['Describe', 'Write the description from the source'],
  [
    'Story',
    'First issued, fun facts and read-more links',
    'Model · local',
    'Escalate when unsure',
    'Redo plates that already have a story',
    'Limit · no limit',
  ],
  [
    'Tag',
    'Suggest tags with the selected model',
    onlyUnderTaggedLabel,
    'Escalate ambiguous plates',
  ],
  [
    'Group',
    'Propose template families',
    'Use colour signal',
    'Background mask',
    'Vision tiebreak',
    'Method · embeddings',
  ],
  ['Order', 'No automatic step yet'],
]

/** Choose the pipeline menu that matches the deployment's local queue support. */
export function RunMenu(
  props: ComponentProps<typeof LegacyRunMenu> & {
    queue?: ReturnType<typeof usePipelineQueue>
  }
) {
  if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' && props.queue)
    return (
      <PipelineRunControls
        batchPlates={props.batchPlates}
        stateName={props.stateName}
        stateCode={props.allPlates?.[0]?.state ?? props.underTagged[0]?.state}
        queue={props.queue}
      />
    )
  return <LegacyRunMenu {...props} />
}

/**
 * Configure and start a tagging or local stage run through the legacy workflow controls.
 */
function LegacyRunMenu({
  underTagged,
  allPlates = [],
  batchPlates,
  stateName,
  disabled,
  disabledReason,
  start,
  modelError,
}: {
  underTagged: RunPlate[]
  allPlates?: RunPlate[]
  batchPlates: RunPlate[]
  stateName: string
  disabledReason?: string
  disabled: boolean
  modelError?: string
  start(
    plates: RunPlate[],
    retry: boolean,
    modelId?: string,
    stage?: PipelineStage,
    modelOptions?: ModelOptions
  ): void
}) {
  const selectedPlates = useSelectedPlates()
  const choice = useTaggingModelChoice()
  const [open, setOpen] = useState(false)
  const timings = useRunTimings(open)
  const trigger = useRef<HTMLButtonElement>(null)
  const [scope, setScope] = useState('under')
  const local = process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1'
  const [limit, setLimit] = useState('25')
  const [onlyUnderTagged, setOnlyUnderTagged] = useState(false)
  const [stageName, setStageName] = useState('Tag')
  const [redoStory, setRedoStory] = useState(false)
  const activeStage = local ? stageName : 'Tag'
  // Let the selection bar open this menu scoped to the current selection.
  const unavailable = disabled || !!disabledReason
  useEffect(
    () =>
      selectionActions.register('runPipeline', {
        run: () => {
          setScope('selected')
          setOpen(true)
        },
        disabled: unavailable,
      }),
    [unavailable]
  )
  const definition = local
    ? LOCAL_STAGE_DEFINITIONS.find((stage) => stage.label === activeStage)
    : undefined
  const localModel = definition?.needsModel ?? false
  const pipelineStage = definition?.stage
  const desktopModels = choice.data?.models.filter(
    (model) => model.runsOn === 'desktop'
  )
  const textChoice = {
    ...choice,
    modelId:
      desktopModels?.find((model) => model.id === choice.modelId)?.id ??
      desktopModels?.[0]?.id,
    hosted: undefined,
    data: choice.data
      ? { ...choice.data, models: desktopModels ?? [] }
      : undefined,
  }
  const activeChoice = localModel ? textChoice : choice
  const validLimit =
    Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 25
  const plates: readonly RunPlate[] =
    scope === 'selected'
      ? selectedPlates
      : scope === 'batch'
        ? batchPlates
        : local && scope === 'all'
          ? allPlates
          : underTagged
  // Reuse the eligible plate list until the selection, stage or run options change.
  const planned = useMemo(
    () =>
      planTagRun(
        activeStage === 'Story' && !redoStory
          ? plates.filter(
              (plate) =>
                !(plate.hasStory ?? plate.checks?.funFacts.status === 'good')
            )
          : plates,
        local && activeStage === 'Tag' && onlyUnderTagged,
        local ? Number(limit) : 25
      ),
    [plates, local, onlyUnderTagged, limit, activeStage, redoStory]
  )
  const count = planned.length
  const stageMs = estimateStageMs(pipelineStage ?? 'tag', timings, {
    tag: choice.modelId,
    desktop: textChoice.modelId,
  })
  /** Check whether a displayed stage can run in the legacy menu's active mode. */
  const enabled = (name: string) =>
    name === 'Tag' ||
    (local && LOCAL_STAGE_DEFINITIONS.some((stage) => stage.label === name))
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            data-run-trigger
            onClick={() => {
              if (selectedPlates.length) setScope('selected')
            }}
            ref={trigger}
            disabled={disabled || !!disabledReason}
            title={disabledReason}
          >
            <IoPlay aria-hidden="true" />
            Run pipeline
            <IoChevronDown
              aria-hidden="true"
              className={cn('transition-transform', open && 'rotate-180')}
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          data-run-menu=""
          align="end"
          collisionPadding={0}
          aria-label="Run pipeline"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            trigger.current?.focus()
          }}
          className="max-h-[min(85dvh,var(--radix-popover-content-available-height))] w-[580px] max-w-[100vw] gap-[var(--stack-gap)] overflow-y-auto rounded-[var(--radius-lg)] bg-[var(--card)] px-5 pt-5 pb-0 text-[var(--ink)] shadow-xl [&>*]:shrink-0 max-[420px]:w-screen max-[420px]:rounded-none"
        >
          <fieldset className="grid gap-2">
            <legend className="label mb-2">Run on</legend>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={scope === 'selected' ? 'primary' : 'outline'}
                aria-pressed={scope === 'selected'}
                disabled={!selectedPlates.length}
                onClick={() => setScope('selected')}
              >
                Selected plates {selectedPlates.length}
              </Button>
              <Button
                size="sm"
                variant={scope === 'batch' ? 'primary' : 'outline'}
                aria-pressed={scope === 'batch'}
                disabled={!batchPlates.length}
                onClick={() => setScope('batch')}
              >
                Plates in your batch {batchPlates.length}
              </Button>
              <Button
                size="sm"
                variant={scope === 'under' ? 'primary' : 'outline'}
                aria-pressed={scope === 'under'}
                onClick={() => setScope('under')}
              >
                Under-tagged plates {underTagged.length}
              </Button>
              <Button
                size="sm"
                variant={scope === 'all' ? 'primary' : 'ghost'}
                disabled={!local || !allPlates.length}
                aria-pressed={scope === 'all'}
                onClick={() => setScope('all')}
                aria-label={
                  local
                    ? `All of ${stateName} ${allPlates.length}`
                    : `All of ${stateName}: Coming soon`
                }
              >
                All of {stateName} {local ? allPlates.length : '· Coming soon'}
              </Button>
              <Button size="sm" variant="ghost" disabled>
                + Add plates from any state ·{' '}
                {local
                  ? 'Use the existing cross-state selection'
                  : 'Coming soon'}
              </Button>
            </div>
            {!local && plates.length > 25 ? (
              <p className="caption">First 25 of {plates.length}</p>
            ) : null}
          </fieldset>
          {local ? (
            <fieldset className="grid gap-2">
              <legend className="label">Run options</legend>
              <label className="caption flex items-center gap-2">
                Limit
                <input
                  aria-label="Limit"
                  type="number"
                  min={1}
                  max={25}
                  step={1}
                  value={limit}
                  onChange={(event) => setLimit(event.target.value)}
                  aria-invalid={!validLimit}
                  className="w-20 rounded-[var(--radius-md)] bg-[var(--fill)] px-3 py-2 text-[var(--ink)]"
                />
              </label>
              <p className="caption">Up to 25 plates per run.</p>
              <p className="caption">
                {count} of {plates.length} plates match this run.
              </p>
              {!validLimit ? (
                <p role="alert" className="caption">
                  Enter a whole number from 1 to 25.
                </p>
              ) : null}
            </fieldset>
          ) : null}
          <section aria-label="Stages and their options" className="grid gap-1">
            <h2 className="label mb-1">Stages and their options</h2>
            {local ? (
              <p className="caption">Choose one stage for this local run.</p>
            ) : null}
            {stages.map(([name, description, ...options]) => (
              <fieldset
                key={name}
                disabled={!enabled(name)}
                className={cn(
                  'rounded-[var(--radius-md)] p-4',
                  options.length > 0 && 'bg-[var(--fill)]',
                  !enabled(name) && 'text-[var(--ink-2)]'
                )}
              >
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    aria-label={
                      enabled(name)
                        ? name
                        : `${name}: ${local ? localStageReasons[name] : 'Coming soon'}`
                    }
                    checked={name === activeStage}
                    onChange={() => {
                      if (enabled(name)) setStageName(name)
                    }}
                    className="accent-[var(--ink)]"
                  />
                  <div className="flex-1">
                    <strong>{name}</strong>
                    <p className="caption">{description}</p>
                  </div>
                  {!enabled(name) ? (
                    <span className="caption">
                      {local ? localStageReasons[name] : 'Coming soon'}
                    </span>
                  ) : null}
                  {name === activeStage ? (
                    <span className="id">
                      {formatEstimate(stageMs)} / plate
                    </span>
                  ) : null}
                </div>
                {name === activeStage && activeStage !== 'Wiki link' ? (
                  <TaggingModelPicker
                    choice={activeChoice}
                    error={modelError}
                  />
                ) : null}
                {options
                  .filter(
                    (option) =>
                      !local ||
                      (!option.startsWith('Limit') &&
                        option !== 'Model · local')
                  )
                  .map((option) => (
                    <label
                      key={option}
                      className="mt-2 flex items-center gap-2 pr-1 pl-7 text-xs"
                    >
                      <input
                        type="checkbox"
                        disabled={
                          !local ||
                          ![
                            onlyUnderTaggedLabel,
                            'Redo plates that already have a story',
                          ].includes(option)
                        }
                        checked={
                          local
                            ? option === onlyUnderTaggedLabel
                              ? onlyUnderTagged
                              : option ===
                                  'Redo plates that already have a story'
                                ? redoStory
                                : false
                            : false
                        }
                        onChange={(event) =>
                          option === onlyUnderTaggedLabel
                            ? setOnlyUnderTagged(event.target.checked)
                            : setRedoStory(event.target.checked)
                        }
                        aria-label={
                          local &&
                          [
                            onlyUnderTaggedLabel,
                            'Redo plates that already have a story',
                          ].includes(option)
                            ? option
                            : `${option}: ${local ? (enabled(name) ? 'Needs confidence-based escalation' : localStageReasons[name]) : 'Coming soon'}`
                        }
                      />
                      {option}
                      <span className="ml-auto text-[var(--ink-2)]">
                        {local
                          ? [
                              onlyUnderTaggedLabel,
                              'Redo plates that already have a story',
                            ].includes(option)
                            ? ''
                            : enabled(name)
                              ? 'Needs confidence-based escalation'
                              : localStageReasons[name]
                          : 'Coming soon'}
                      </span>
                    </label>
                  ))}
              </fieldset>
            ))}
          </section>
          <footer className="sticky bottom-0 grid gap-3 border-t border-[var(--hairline)] bg-[var(--card)] pt-3 pb-5">
            <label className="caption flex gap-2">
              <input type="checkbox" disabled />
              Preview only ·{' '}
              {local
                ? 'Needs a result-only run without Batch writes'
                : 'Coming soon'}
            </label>
            <p className="caption">
              {count} plates · {activeStage} ·{' '}
              {count
                ? `${formatEstimate(count * stageMs)} processing time · `
                : ''}
              Suggestions land here for you to accept.
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={
                  disabled ||
                  count === 0 ||
                  (local && !validLimit) ||
                  (localModel && !activeChoice.modelId)
                }
                onClick={() => {
                  if (pipelineStage)
                    start(
                      planned,
                      false,
                      definition?.needsModel ? activeChoice.modelId : undefined,
                      pipelineStage
                    )
                  else if (choice.modelOptions)
                    start(
                      planned,
                      false,
                      choice.modelId,
                      undefined,
                      choice.modelOptions
                    )
                  else start(planned, false, choice.modelId)
                  setOpen(false)
                }}
              >
                <IoPlay aria-hidden="true" />
                Start run
              </Button>
            </div>
            <Button size="sm" variant="outline" disabled>
              Queue · {local ? 'Needs a deferred run scheduler' : 'Coming soon'}
            </Button>
          </footer>
        </PopoverContent>
      </Popover>
      {modelError && !open ? (
        <p role="alert" className="caption">
          {modelError}
        </p>
      ) : null}
    </>
  )
}
