'use client'

import { useMemo, useRef, useState } from 'react'
import { IoChevronDown, IoPlay } from 'react-icons/io5'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/components/utils'
import { defaultPipelineOptions, type PipelineOptions } from '@/lib/jobs/pipeline-options'
import type { LocalRunStage } from '@/lib/jobs/queue-types'
import { useSelectedPlates } from './plate-selection'
import { planTagRun } from './local-pipeline'
import { pipelineStages, stageAvailability } from './pipeline-stages'
import { TaggingModelPicker, useTaggingModelChoice } from './tagging-model-picker'
import type { RunPlate } from './use-tag-run'
import type { usePipelineQueue } from './use-pipeline-queue'
import type { TaggingModelId } from '@/lib/tagging/models'

type Controls = Pick<ReturnType<typeof usePipelineQueue>, 'runs' | 'action' | 'message' | 'disabledReason' | 'enqueue'>

export function PipelineRunControls({ underTagged, allPlates = [], batchPlates, stateName, queue, disabledReason }: {
  underTagged: RunPlate[]; allPlates?: RunPlate[]; batchPlates: RunPlate[]; stateName: string; queue: Controls; disabledReason?: string
}) {
  const selected = useSelectedPlates()
  const choice = useTaggingModelChoice()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const [scope, setScope] = useState('under')
  const [limit, setLimit] = useState('25')
  const [stages, setStages] = useState<LocalRunStage[]>(['tag'])
  const [options, setOptions] = useState<PipelineOptions>({})
  const [previewOnly, setPreviewOnly] = useState(false)
  const desktop = choice.data?.models.filter(model => model.runsOn === 'desktop') ?? []
  const modelId = (desktop.find(model => model.id === choice.modelId)?.id ?? desktop[0]?.id) as TaggingModelId | undefined
  const localChoice = { ...choice, modelId, data: choice.data ? { ...choice.data, models: desktop } : undefined }
  const plates = scope === 'selected' ? selected : scope === 'batch' ? batchPlates : scope === 'all' ? allPlates : underTagged
  const planned = useMemo(() => planTagRun(plates, false, Number(limit)), [plates, limit])
  const validLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 && Number(limit) <= 25
  const reason = disabledReason ?? queue.disabledReason
  const posting = queue.action === 'enqueue'
  const active = queue.runs.some(run => ['queued', 'running'].includes(run.status))
  const blocked = !!reason || !validLimit || !planned.length || !stages.length || !modelId || !!queue.action
  async function enqueue() {
    if (blocked) return
    if (await queue.enqueue([...planned], stages, modelId, options, previewOnly)) setOpen(false)
  }
  function option(stage: keyof PipelineOptions, key: string, value: string | boolean) {
    setOptions(current => ({ ...current, [stage]: { ...defaultPipelineOptions[stage], ...current[stage], [key]: value } }))
  }
  return <div className="grid gap-2">
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button ref={trigger} data-run-trigger disabled={!!reason} title={reason} onClick={() => { if (selected.length) setScope('selected') }}>
        <IoPlay aria-hidden="true" />Run pipeline<IoChevronDown aria-hidden="true" className={cn('transition-transform', open && 'rotate-180')} />
      </Button></PopoverTrigger>
      <PopoverContent align="end" collisionPadding={0} data-run-menu="" aria-label="Run pipeline"
        onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus() }}
        className="max-h-[min(85dvh,var(--radix-popover-content-available-height))] w-[580px] max-w-[100vw] gap-[var(--stack-gap)] overflow-y-auto rounded-[var(--radius-lg)] bg-[var(--card)] px-5 pt-5 pb-0 text-[var(--ink)] shadow-xl [&>*]:shrink-0 max-[420px]:w-screen max-[420px]:rounded-none">
        <fieldset className="grid gap-2"><legend className="label mb-2">Run on</legend>
          <div className="flex flex-wrap gap-2">{[
            ['selected', `Selected plates ${selected.length}`, selected.length], ['batch', `Plates in your batch ${batchPlates.length}`, batchPlates.length],
            ['under', `Under-tagged plates ${underTagged.length}`, underTagged.length], ['all', `All plates in ${stateName} ${allPlates.length}`, allPlates.length],
          ].map(([id, label, count]) => <Button key={id} size="sm" variant={scope === id ? 'primary' : 'outline'} aria-pressed={scope === id} disabled={!count} onClick={() => setScope(String(id))}>{label}</Button>)}</div>
          <label className="caption flex items-center gap-2">Plate limit<input type="number" min={1} max={25} value={limit} onChange={event => setLimit(event.target.value)} className="w-20 rounded-[var(--radius-sm)] bg-[var(--fill)] p-2" /></label>
          <p className="caption">First {planned.length} of {plates.length}</p>
        </fieldset>
        <section className="grid gap-[var(--stack-gap)]"><h2 className="label">Stages and their options</h2>
          {pipelineStages.map(stage => {
            const unavailable = stageAvailability(stage, true)
            const checked = stages.includes(stage.id as LocalRunStage)
            return <fieldset key={stage.id} disabled={!!unavailable} className={cn('grid gap-2 rounded-[var(--radius-md)] p-4', stage.options.length > 0 && 'bg-[var(--fill)]', unavailable && 'text-[var(--ink-2)]')}>
              <label className="flex items-center gap-3"><input type="checkbox" checked={checked} aria-label={unavailable ? `${stage.label}: ${unavailable}` : stage.label}
                onChange={event => setStages(current => event.target.checked ? pipelineStages.filter(candidate => candidate.id !== 'order' && (candidate.id === stage.id || current.includes(candidate.id))).map(candidate => candidate.id as LocalRunStage) : current.filter(id => id !== stage.id))} />
                <span className="flex-1"><strong>{stage.label}</strong><span className="caption block">{stage.description}</span></span><span className="id">{stage.duration}</span></label>
              {unavailable ? <p className="caption">{unavailable}</p> : null}
              {stage.options.map(setting => {
                const values = { ...defaultPipelineOptions[stage.id as keyof PipelineOptions], ...options[stage.id as keyof PipelineOptions] } as Record<string, string | boolean>
                const value = values[setting.id] ?? setting.default
                return <label key={setting.id} className="caption flex items-center gap-2 pl-7">
                  {setting.kind === 'boolean' ? <input type="checkbox" checked={value === true} disabled={!checked || !!setting.disabledReason} onChange={event => option(stage.id as keyof PipelineOptions, setting.id, event.target.checked)} /> : null}
                  {setting.label}
                  {setting.kind === 'select' ? <select value={String(value)} disabled={!checked || !!setting.disabledReason} onChange={event => option(stage.id as keyof PipelineOptions, setting.id, event.target.value)} className="rounded-[var(--radius-sm)] bg-[var(--card)] p-2">
                    {setting.choices?.map(choice => <option key={choice.value} value={choice.value} disabled={!!choice.disabledReason}>{choice.label}{choice.disabledReason ? ` · ${choice.disabledReason}` : ''}</option>)}
                  </select> : null}
                  {setting.disabledReason ? <span className="text-[var(--ink-2)]">{setting.disabledReason}</span> : null}
                </label>
              })}
            </fieldset>
          })}
        </section>
        <TaggingModelPicker choice={localChoice} />
        <footer className="sticky bottom-0 grid gap-[var(--stack-gap)] border-t border-[var(--hairline)] bg-[var(--card)] pt-3 pb-5">
          <label className="caption flex items-center gap-2"><input type="checkbox" checked={previewOnly} onChange={event => setPreviewOnly(event.target.checked)} />Preview only · generate suggestions without changing the Batch</label>
          <p className="caption">Up to {planned.length} plates · {stages.map(id => pipelineStages.find(stage => stage.id === id)?.label).join(' → ') || 'Choose stages'}. Suggestions wait for your explicit Apply.</p>
          {active ? <p className="caption">A run is already active. You can queue these plates and stages; each resource slot is shared fairly between requesters.</p> : null}
          {queue.message ? <p role="alert">{queue.message}</p> : null}
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
