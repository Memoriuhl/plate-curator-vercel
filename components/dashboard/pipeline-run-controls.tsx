'use client'

import { useMemo, useRef, useState } from 'react'
import { IoChevronDown, IoPlay } from 'react-icons/io5'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/components/utils'
import { defaultPipelineOptions, snapshotPipelineOptions, type PipelineOptions } from '@/lib/jobs/pipeline-options'
import type { LocalRunStage } from '@/lib/jobs/queue-types'
import { useSelectedPlates } from './plate-selection'
import { pipelineSelectionLimit } from '@/lib/jobs/pipeline-selection'
import { groupSelectionLimit } from '@/lib/review/group-context'
import { newRunStages, stageAvailability } from './pipeline-stages'
import { TaggingModelPicker, useTaggingModelChoice } from './tagging-model-picker'
import type { RunPlate } from './use-tag-run'
import type { usePipelineQueue } from './use-pipeline-queue'
import type { TaggingModelId } from '@/lib/tagging/models'
import { planPipeline, pipelineNeedsModel } from '@/lib/jobs/pipeline-plan'
import { ResearchModelPicker, researchModelLabel, useResearchModelChoice } from './research-model-picker'

type Controls = Pick<ReturnType<typeof usePipelineQueue>, 'runs' | 'action' | 'message' | 'disabledReason' | 'enqueue'> & Partial<Pick<ReturnType<typeof usePipelineQueue>, 'capabilities' | 'selectedBatchName' | 'existingBatchName'>>

export function PipelineRunControls({ underTagged, allPlates = [], batchPlates, stateName, queue, disabledReason }: {
  underTagged: RunPlate[]; allPlates?: RunPlate[]; batchPlates: RunPlate[]; stateName: string; queue: Controls; disabledReason?: string
}) {
  const selected = useSelectedPlates()
  const choice = useTaggingModelChoice()
  const desktopChoice = useTaggingModelChoice('pipeline-desktop-model:v1')
  const researchChoice = useResearchModelChoice()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [scope, setScope] = useState('under')
  const [limit, setLimit] = useState('')
  const [stages, setStages] = useState<LocalRunStage[]>(['tag'])
  const [options, setOptions] = useState<PipelineOptions>({})
  const [previewOnly, setPreviewOnly] = useState(false)
  const desktop = choice.data?.models.filter(model => model.runsOn === 'desktop') ?? []
  const modelId = (desktop.find(model => model.id === desktopChoice.modelId)?.id ?? desktop[0]?.id) as TaggingModelId | undefined
  const localChoice = { ...desktopChoice, modelId, data: choice.data ? { ...choice.data, models: desktop } : undefined }
  const plates: readonly RunPlate[] = scope === 'selected' ? selected : scope === 'batch' ? batchPlates : scope === 'all' ? allPlates : underTagged
  const count = limit ? Number(limit) : plates.length
  const validLimit = Number.isInteger(count) && count > 0 && count <= pipelineSelectionLimit
  const planned = useMemo(() => validLimit ? plates.slice(0, count) : [], [plates, count, validLimit])
  const destination = queue.selectedBatchName ?? (previewOnly ? queue.existingBatchName : undefined)
  const selectedStates = new Set(planned.map(plate => plate.state))
  const firstState = planned[0]?.state
  const currentState = allPlates[0]?.state ?? underTagged[0]?.state
  const newBatchName = selectedStates.size > 1 ? 'Cross-state pipeline' : `${firstState && currentState && firstState !== currentState ? firstState : stateName} pipeline`
  const reason = disabledReason ?? queue.disabledReason
  const posting = queue.action === 'enqueue'
  const active = queue.runs.some(run => ['queued', 'running'].includes(run.status))
  const unavailableStage = newRunStages.some(stage => stages.includes(stage.id as LocalRunStage) && stageAvailability(stage, true, queue.capabilities))
  const groupOutsideBatch = stages.includes('group') && !!destination && planned.some(plate => !batchPlates.some(member => member.id === plate.id))
  const invalidGroupSize = stages.includes('group') && (planned.length > groupSelectionLimit || selectedStates.size > 1)
  const resolvedOptions = snapshotPipelineOptions(stages, options)
  if (resolvedOptions.group) for (const key of ['colorSignal', 'backgroundMask', 'visionTiebreak'] as const) {
    if (!queue.capabilities?.[key].available) resolvedOptions.group[key] = false
  }
  const steps = planPipeline(planned.map(plate => ({ ...plate, description: plate.description ?? plate.checks?.description?.value, hasStory: plate.hasStory ?? plate.checks?.funFacts.status === 'good' })), stages, resolvedOptions)
  const needsModel = pipelineNeedsModel(steps.filter(step => step.stage !== 'tag'), resolvedOptions)
  const needsTagModel = steps.some(step => step.stage === 'tag')
  const needsResearchModel = steps.some(step => step.stage === 'research')
  const researchModel = needsResearchModel ? researchChoice.model : undefined
  const blocked = !!reason || !validLimit || !steps.length || needsModel && !modelId || needsTagModel && !choice.modelId || needsResearchModel && !researchModel || !!queue.action || unavailableStage || groupOutsideBatch || invalidGroupSize
  async function enqueue() {
    if (blocked) return
    if (await queue.enqueue([...planned], stages, needsModel ? modelId : needsTagModel ? choice.modelId : undefined, resolvedOptions, previewOnly, needsTagModel ? choice.modelId : undefined, researchModel?.id, newBatchName)) setOpen(false)
  }
  function option(stage: keyof PipelineOptions, key: string, value: string | boolean) {
    setOptions(current => ({ ...current, [stage]: { ...defaultPipelineOptions[stage], ...current[stage], [key]: value } }))
  }
  return <div className="grid gap-2">
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button ref={trigger} data-run-trigger disabled={!!reason} title={reason} onClick={() => { if (selected.length) setScope('selected') }}>
        <IoPlay aria-hidden="true" />Run pipeline<IoChevronDown aria-hidden="true" className={cn('transition-transform', open && 'rotate-180')} />
      </Button></PopoverTrigger>
      <PopoverContent ref={menu} align="end" collisionPadding={0} data-run-menu="" aria-label="Run pipeline"
        onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus() }}
        onInteractOutside={event => {
          const list = event.target instanceof Element && event.target.closest('[data-slot="select-content"]')
          if (list && menu.current?.querySelector(`[aria-controls="${CSS.escape(list.id)}"]`)) event.preventDefault()
        }}
        className="max-h-[min(85dvh,var(--radix-popover-content-available-height))] w-[580px] max-w-[100vw] gap-[var(--stack-gap)] overflow-y-auto rounded-[var(--radius-lg)] bg-[var(--card)] px-5 pt-5 pb-0 text-[var(--ink)] shadow-xl [&>*]:min-w-0 [&>*]:shrink-0 [&_fieldset]:min-w-0 max-[420px]:w-screen max-[420px]:rounded-none">
        <fieldset className="grid gap-2"><legend className="label mb-2">Run on</legend>
          <div className="flex flex-wrap gap-2">{[
            ['selected', `Selected plates ${selected.length}`, selected.length], ['batch', `Plates in your batch ${batchPlates.length}`, batchPlates.length],
            ['under', `Under-tagged plates ${underTagged.length}`, underTagged.length], ['all', `All plates in ${stateName} ${allPlates.length}`, allPlates.length],
          ].map(([id, label, count]) => <Button key={id} size="sm" variant={scope === id ? 'primary' : 'outline'} aria-pressed={scope === id} disabled={!count} onClick={() => setScope(String(id))}>{label}</Button>)}</div>
          <label className="caption flex items-center gap-2">Plate limit<input type="number" min={1} max={pipelineSelectionLimit} placeholder="All" value={limit} onChange={event => setLimit(event.target.value)} className="w-20 rounded-[var(--radius-sm)] bg-[var(--fill)] p-2" /></label>
          <p className="caption">{planned.length} of {plates.length} plates</p>
          {count > pipelineSelectionLimit ? <p role="alert" className="caption">Select up to {pipelineSelectionLimit.toLocaleString()} plates per Batch.</p> : null}
        </fieldset>
        <section className="grid gap-[var(--stack-gap)]"><h2 className="label">Stages and their options</h2>
          {newRunStages.map(stage => {
            const unavailable = stageAvailability(stage, true, queue.capabilities)
            const checked = stages.includes(stage.id as LocalRunStage)
            return <fieldset key={stage.id} className={cn('grid gap-2 rounded-[var(--radius-md)] p-4', stage.options.length > 0 && 'bg-[var(--fill)]', unavailable && 'text-[var(--ink-2)]')}>
              <label className="flex items-center gap-3"><input type="checkbox" disabled={!!unavailable && !checked} checked={checked} aria-label={unavailable ? `${stage.label}: ${unavailable}` : stage.label}
                onChange={event => setStages(current => event.target.checked ? newRunStages.filter(candidate => candidate.id !== 'order' && (candidate.id === stage.id || current.includes(candidate.id))).map(candidate => candidate.id as LocalRunStage) : current.filter(id => id !== stage.id))} />
                <span className="flex-1"><strong>{stage.label}</strong><span className="caption block">{stage.description}</span></span><span className="id">{stage.duration}</span></label>
              {unavailable ? <p className="caption">{unavailable}</p> : null}
              {stage.options.map(setting => {
                const values = { ...defaultPipelineOptions[stage.id as keyof PipelineOptions], ...resolvedOptions[stage.id as keyof PipelineOptions] } as Record<string, string | boolean>
                const capability = stage.id === 'group' ? queue.capabilities?.[setting.id === 'method' ? 'embeddings' : setting.id as 'colorSignal' | 'backgroundMask' | 'visionTiebreak'] : undefined
                const disabledReason = setting.disabledReason ?? (stage.id === 'group' && !capability?.available ? capability?.reason ?? 'Local worker not reporting' : undefined)
                const value = stage.id === 'group' && setting.kind === 'boolean' && disabledReason ? false : values[setting.id] ?? setting.default
                return <label key={setting.id} className="caption flex items-center gap-2 pl-7">
                  {setting.kind === 'boolean' ? <input type="checkbox" checked={value === true} disabled={!checked || !!unavailable || !!disabledReason} onChange={event => option(stage.id as keyof PipelineOptions, setting.id, event.target.checked)} /> : null}
                  {setting.label}
                  {setting.kind === 'select' ? <select value={String(value)} disabled={!checked || !!unavailable || !!disabledReason} onChange={event => option(stage.id as keyof PipelineOptions, setting.id, event.target.value)} className="rounded-[var(--radius-sm)] bg-[var(--card)] p-2">
                    {setting.choices?.map(choice => <option key={choice.value} value={choice.value} disabled={!!choice.disabledReason}>{choice.label}{choice.disabledReason ? ` · ${choice.disabledReason}` : ''}</option>)}
                  </select> : null}
                  {disabledReason ? <span className="text-[var(--ink-2)]">{disabledReason}</span> : null}
                </label>
              })}
              {stage.id === 'research' && checked ? <div className="pl-7">
                {needsResearchModel ? <ResearchModelPicker choice={researchChoice} />
                  : planned.length ? <p className="caption">The selected plates already have research fields. Choose Replace existing to research them again.</p> : null}
              </div> : null}
            </fieldset>
          })}
        </section>
        {needsTagModel ? <div className="grid gap-1"><p className="label">Tag model</p><TaggingModelPicker choice={choice} /></div> : null}
        {needsModel ? <div className="grid gap-1"><p className="label">Desktop stage model</p><TaggingModelPicker choice={localChoice} /></div> : null}
        <footer className="sticky bottom-0 grid gap-[var(--stack-gap)] border-t border-[var(--hairline)] bg-[var(--card)] pt-3 pb-5">
          <label className="caption flex items-center gap-2"><input type="checkbox" checked={previewOnly} onChange={event => setPreviewOnly(event.target.checked)} />Preview only · inspect results, Apply is unavailable</label>
          <p className="caption">{destination ? `Batch · ${destination}` : previewOnly ? 'Preview requires an existing open Batch.' : `New draft · ${newBatchName}`}</p>
          <p className="caption">Up to {planned.length} plates · {newRunStages.filter(stage => stages.includes(stage.id as LocalRunStage)).map(stage => stage.label).join(' → ') || 'Choose stages'}. {previewOnly ? 'Run again without Preview only to apply changes.' : 'Validated results save to the draft as they arrive.'}</p>
          {researchModel ? <p className="caption">Research will use {researchModelLabel(researchModel)}.</p> : null}
          {active ? <p className="caption">A run is already active. You can queue these plates and stages; each resource slot is shared fairly between requesters.</p> : null}
          {queue.message ? <p role="alert">{queue.message}</p> : null}
          {invalidGroupSize ? <p role="alert">Group needs up to {groupSelectionLimit} plates from one state. Deselect Group to run the other stages across this selection.</p>
            : groupOutsideBatch ? <p role="alert">Every Group member must already be in this Batch. Choose a complete family scope from plates in your Batch.</p> : null}
          <div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={blocked || active} onClick={() => void enqueue()}><IoPlay aria-hidden="true" />{posting ? 'Saving run…' : 'Start run'}</Button>
            <Button variant="outline" disabled={blocked} onClick={() => void enqueue()}>{posting ? 'Saving run…' : 'Queue run'}</Button>
          </div>
        </footer>
      </PopoverContent>
    </Popover>
    {queue.message && !open ? <p role="alert" className="caption">{queue.message}</p> : null}
  </div>
}
