'use client'

import { useId, useRef, useState } from 'react'
import { IoArrowForwardOutline, IoChevronDown, IoListOutline, IoPlay } from 'react-icons/io5'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/components/utils'
import { defaultPipelineOptions, snapshotPipelineOptions, type PipelineOptions } from '@/lib/jobs/pipeline-options'
import { canonicalStages, planPipeline, pipelineNeedsModel } from '@/lib/jobs/pipeline-plan'
import type { LocalRunStage } from '@/lib/jobs/queue-types'
import { shouldReuseSavedSources } from '@/lib/research/enrichment'
import { groupSelectionLimit } from '@/lib/review/group-context'
import { enhancementOperations } from '@/lib/jobs/image-enhancement'
import { useSelectedPlates } from './plate-selection'
import { newRunStages, stageAvailability } from './pipeline-stages'
import { PipelineOptionSelect } from './pipeline-option-select'
import { TaggingModelPicker, useTaggingModelChoice } from './tagging-model-picker'
import { ResearchModelPicker, useResearchModelChoice } from './research-model-picker'
import type { RunPlate } from './use-tag-run'
import type { usePipelineQueue } from './use-pipeline-queue'
import { estimateStageMs, formatEstimate, useRunTimings } from './pipeline-estimates'

const selectedPlateLimit = 200
const flowStepsPerRow = 4
const groupFeatures = ['colorSignal', 'backgroundMask', 'visionTiebreak'] as const

type Controls = Pick<ReturnType<typeof usePipelineQueue>, 'runs' | 'action' | 'message' | 'disabledReason' | 'enqueue'> &
  Partial<Pick<ReturnType<typeof usePipelineQueue>, 'capabilities' | 'selectedBatchName'>>

export function PipelineRunControls({ batchPlates, stateName, stateCode, queue }: {
  batchPlates: RunPlate[]; stateName: string; stateCode?: string; queue: Controls
}) {
  const selected = useSelectedPlates()
  const tagChoice = useTaggingModelChoice()
  const desktopChoice = useTaggingModelChoice('pipeline-desktop-model:v1')
  const researchChoice = useResearchModelChoice()
  const [open, setOpen] = useState(false)
  const timings = useRunTimings(open)
  const [stages, setStages] = useState<LocalRunStage[]>([])
  const [expanded, setExpanded] = useState<LocalRunStage[]>([])
  const [options, setOptions] = useState<PipelineOptions>({})
  const trigger = useRef<HTMLButtonElement>(null)
  const optionsId = useId()

  const desktop = desktopChoice.data?.models.filter(model => model.runsOn === 'desktop') ?? []
  const modelId = desktop.find(model => model.id === desktopChoice.modelId)?.id ?? desktop[0]?.id
  const localChoice = { ...desktopChoice, modelId, data: desktopChoice.data ? { ...desktopChoice.data, models: desktop } : undefined }
  const selectedStates = new Set(selected.map(plate => plate.state))
  const firstState = selected[0]?.state
  const batchName = selectedStates.size > 1 ? 'Cross-state pipeline' : `${firstState && stateCode && firstState !== stateCode ? firstState : stateName} pipeline`
  const posting = queue.action === 'enqueue'
  const active = queue.runs.some(run => run.status === 'queued' || run.status === 'running')
  const unavailable = newRunStages.some(stage => stages.includes(stage.id) && stageAvailability(stage, true, queue.capabilities))
  const groupSelected = stages.includes('group')
  const groupOutsideBatch = groupSelected && !!queue.selectedBatchName && selected.some(plate => !batchPlates.some(member => member.id === plate.id))
  const invalidGroupSize = groupSelected && (selected.length > groupSelectionLimit || selectedStates.size > 1)
  const overLimit = selected.length > selectedPlateLimit

  const resolvedOptions = snapshotPipelineOptions(stages, options)
  if (resolvedOptions.group) for (const feature of groupFeatures) {
    if (!queue.capabilities?.[feature].available) resolvedOptions.group[feature] = false
  }
  const enhancement = resolvedOptions['enhance-image']
  const invalidEnhancement = !!enhancement && !enhancementOperations.some(key => enhancement[key])
  const runPlates = selected.map(({ id, tags, imageUrl, checks, wikiUrl, funFacts, firstIssuedYear, readMore }) => ({
    id, tags, imageUrl, description: checks?.description?.value, wikiUrl, funFacts, firstIssuedYear, readMore,
  }))
  const steps = planPipeline(runPlates, stages, resolvedOptions)
  const timingModels = { tag: tagChoice.modelId, desktop: modelId, research: researchChoice.model?.id }
  const estimates = new Map(canonicalStages.map(id => [id, estimateStageMs(id, timings, timingModels, resolvedOptions)]))
  const totalMs = steps.reduce((total, step) => total + estimates.get(step.stage)!, 0)
  const needsModel = pipelineNeedsModel(steps.filter(step => step.stage !== 'tag'), resolvedOptions)
  const needsTagModel = steps.some(step => step.stage === 'tag')
  const needsResearchModel = steps.some(step => step.stage === 'research')
  const tagModel = needsTagModel ? tagChoice.modelId : undefined
  const researchModel = needsResearchModel ? researchChoice.model : undefined
  const useSavedSources = shouldReuseSavedSources(options.research)
  const blocked = !!queue.disabledReason || overLimit || !steps.length || needsModel && !modelId ||
    needsTagModel && !tagModel || needsResearchModel && !researchModel || !!queue.action || unavailable || invalidEnhancement || groupOutsideBatch || invalidGroupSize

  async function enqueue() {
    if (blocked) return
    if (await queue.enqueue([...selected], stages, needsModel ? modelId : tagModel, resolvedOptions, false, tagModel, researchModel?.id, batchName)) setOpen(false)
  }

  function setOption(stage: keyof PipelineOptions, key: string, value: string | boolean) {
    setOptions(current => ({ ...current, [stage]: { ...defaultPipelineOptions[stage], ...current[stage], [key]: value } }))
  }

  return <div className="grid gap-2">
    <Popover open={open} onOpenChange={nextOpen => {
      if (nextOpen) { setStages([]); setExpanded([]) }
      setOpen(nextOpen)
    }}>
      <PopoverTrigger asChild><Button ref={trigger} className="pt-0 [&_svg]:mt-0" data-run-trigger disabled={!!queue.disabledReason} title={queue.disabledReason}>
        <IoPlay aria-hidden="true" />Run pipeline<IoChevronDown aria-hidden="true" className={cn('transition-transform', open && 'rotate-180')} />
      </Button></PopoverTrigger>
      <PopoverContent align="end" collisionPadding={8} data-run-menu="" aria-label="Run pipeline"
        onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus() }}
        className="max-h-[min(85dvh,var(--radix-popover-content-available-height))] w-[620px] max-w-[calc(100vw-16px)] gap-4 overflow-y-auto rounded-[var(--radius-lg)] bg-[var(--card)] px-4 pt-4 pb-0 text-[var(--ink)] shadow-xl [&>*]:min-w-0 [&>*]:shrink-0">
        <header className="grid gap-1">
          <p className="font-normal">Selected plates <strong className="font-extrabold tabular-nums">{selected.length.toLocaleString()}</strong></p>
          <p className="caption text-[var(--ink-2)]" role={overLimit ? 'alert' : undefined}>Up to {selectedPlateLimit} plates per run</p>
        </header>
        <div className="grid gap-2" role="group" aria-label="Pipeline stages">
          {newRunStages.map(stage => {
            const { id } = stage
            const availability = stageAvailability(stage, true, queue.capabilities)
            const checked = stages.includes(id)
            const showingOptions = expanded.includes(id)
            const panelId = `${optionsId}-${id}`
            const optionStage = id as keyof PipelineOptions
            const values = { ...defaultPipelineOptions[optionStage], ...options[optionStage] } as Record<string, string | boolean>
            return <div key={id} className={cn('rounded-[var(--radius-md)] border bg-[var(--fill)]', checked ? 'border-primary' : 'border-transparent')}>
              <div className="flex items-stretch">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-3 pl-3">
                  <input type="checkbox" checked={checked} aria-label={stage.label} className="accent-[var(--primary)]"
                    onChange={event => {
                      const next = event.target.checked
                      setStages(current => next ? newRunStages.filter(candidate => candidate.id === id || current.includes(candidate.id)).map(candidate => candidate.id) : current.filter(item => item !== id))
                    }} />
                  <span className="min-w-0 flex-1">
                    <strong className="flex items-center gap-2">
                      <stage.icon aria-hidden="true" className="size-4" />
                      {stage.label}
                    </strong>
                    <span className="caption block">{stage.description}</span>
                    {stage.flow ? <span role="list" aria-label={`${stage.label} steps`}
                      className="caption mt-2 grid items-center gap-x-3 gap-y-1 overflow-x-auto text-[var(--ink-2)]"
                      style={{ gridTemplateColumns: `repeat(${Math.min(stage.flow.length, flowStepsPerRow)}, max-content)` }}>
                      {stage.flow.map(({ label, icon: StepIcon }, index) => (
                        <span key={label} role="listitem" className="flex min-w-0 items-center gap-1">
                          {index % flowStepsPerRow !== 0 ? <IoArrowForwardOutline aria-hidden="true" className="size-3 shrink-0" /> : null}
                          <StepIcon aria-hidden="true" className="size-3.5 shrink-0" />
                          <span className="whitespace-nowrap">{id === 'research' && index === 0 && useSavedSources ? 'Use saved sources' : label}</span>
                        </span>
                      ))}
                    </span> : null}
                    {availability ? <span className="caption block text-[var(--ink-2)]">{availability}</span> : null}
                    {id === 'research' && checked && selected.length > 0 && !needsResearchModel
                      ? <span className="caption block">Research fields are filled. Choose Replace existing to run again.</span> : null}
                  </span>
                  {!stageAvailability(stage, true, queue.capabilities) && <span className="id shrink-0 whitespace-nowrap">{formatEstimate(estimates.get(id)!)}{id === 'group' ? ' / group' : ' / plate'}</span>}
                </label>
                <button type="button" aria-label={`More options for ${stage.label}`} aria-expanded={showingOptions} aria-controls={panelId}
                  className="flex w-11 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-[var(--ink-2)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-primary"
                  onClick={() => setExpanded(current => showingOptions ? current.filter(item => item !== id) : [...current, id])}>
                  <IoChevronDown aria-hidden="true" className={cn('size-4 transition-transform', showingOptions && 'rotate-180')} />
                </button>
              </div>
              <div id={panelId} hidden={!showingOptions}>
                {showingOptions ? <div className="grid gap-3 rounded-b-[var(--radius-md)] border-t border-[var(--hairline)] bg-[color-mix(in_srgb,var(--fill)_94%,black)] px-3 py-3">
                  {stage.options.map(setting => {
                    const value = values[setting.id] ?? setting.default
                    if (setting.kind === 'select') {
                      return <PipelineOptionSelect key={setting.id} label={setting.label} choices={setting.choices ?? []}
                        value={String(value)} onChange={next => setOption(optionStage, setting.id, next)} />
                    }
                    const capability = id === 'group' ? queue.capabilities?.[setting.id as typeof groupFeatures[number]] : undefined
                    if (id === 'group' && !capability?.available) {
                      return <p key={setting.id} className="caption text-[var(--ink-2)]">{setting.label} · {capability?.reason ?? 'Unavailable on the local worker'}</p>
                    }
                    return <label key={setting.id} className="caption flex cursor-pointer items-center gap-2">
                      <input type="checkbox" checked={value === true} onChange={event => setOption(optionStage, setting.id, event.target.checked)} />
                      {setting.label}
                    </label>
                  })}
                  {id === 'research' && values.reuseSavedSources === true ? <p className="caption">
                    {values.policy === 'replace' ? 'Replace existing searches for sources again.' : 'Skips plates without a usable saved source.'}
                  </p> : null}
                  {id === 'research' ? <ResearchModelPicker choice={researchChoice} /> : null}
                  {id === 'tag' ? <TaggingModelPicker choice={tagChoice} inlineLabel="Tagging model" /> : null}
                  {id === 'group' && values.visionTiebreak === true && queue.capabilities?.visionTiebreak.available
                    ? <TaggingModelPicker choice={localChoice} inlineLabel="Desktop stage model" /> : null}
                </div> : null}
              </div>
            </div>
          })}
        </div>
        <footer className="sticky bottom-0 grid gap-2 border-t border-[var(--hairline)] bg-[var(--card)] pt-3 pb-4">
          {invalidEnhancement ? <p role="alert" className="caption">Choose at least one enhancement.</p> : null}
          {!blocked && steps.length > 0 && <p className="caption tabular-nums">{formatEstimate(totalMs)} processing time</p>}
          {queue.message ? <p role="alert" className="caption">{queue.message}</p> : null}
          {invalidGroupSize ? <p role="alert" className="caption">Group needs up to {groupSelectionLimit} plates from one state.</p>
            : groupOutsideBatch ? <p role="alert" className="caption">Every Group member must already be in this Batch.</p> : null}
          <Button className="justify-self-end pt-0 [&_svg]:mt-0" disabled={blocked} onClick={() => void enqueue()}>
            {active ? <IoListOutline aria-hidden="true" /> : <IoPlay aria-hidden="true" />}
            {posting ? 'Saving run…' : active ? 'Queue Run' : 'Start Run'}
          </Button>
        </footer>
      </PopoverContent>
    </Popover>
    {queue.message && !open ? <p role="alert" className="caption">{queue.message}</p> : null}
  </div>
}
