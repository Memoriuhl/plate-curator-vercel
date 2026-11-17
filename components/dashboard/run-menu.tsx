'use client'

import { useSelectedPlates } from './plate-selection'
import { useMemo, useRef, useState } from 'react'
import { IoChevronDown, IoPlay } from 'react-icons/io5'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/components/utils'
import { TaggingModelPicker, useTaggingModelChoice } from './tagging-model-picker'
import type { TaggingModelId } from '@/lib/tagging/models'
import type { RunPlate } from './use-tag-run'
import { localStageReasons, planTagRun } from './local-pipeline'

const stages = [
  [
    'Find image',
    'Search for a clean plate photo',
    '0:20',
    'Only plates missing an image',
  ],
  ['Wiki link', 'Match a Wikipedia or DMV page', '0:15'],
  ['Colors', 'Background and text colours', '0:05'],
  ['Describe', 'Write the description from the source', '1:30'],
  [
    'Story',
    'First issued, fun facts and read-more links',
    '2:10',
    'Model · local',
    'Escalate when unsure',
    'Redo plates that already have a story',
    'Limit · no limit',
  ],
  [
    'Tag',
    'Suggest tags with the selected model',
    '0:40',
    'Only under-tagged plates',
    'Escalate ambiguous plates',
  ],
  [
    'Group',
    'Propose template families',
    '1:00',
    'Use colour signal',
    'Background mask',
    'Vision tiebreak',
    'Method · embeddings',
  ],
  ['Order', 'No automatic step yet', '—'],
]

export function RunMenu({
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
  start(plates: RunPlate[], retry: boolean, modelId?: TaggingModelId): void
}) {
  const selectedPlates = useSelectedPlates()
  const choice = useTaggingModelChoice()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const [scope, setScope] = useState('under')
  const local = process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1'
  const [limit, setLimit] = useState('25')
  const [onlyUnderTagged, setOnlyUnderTagged] = useState(false)
  const validLimit = Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 25
  const plates = scope === 'selected' ? selectedPlates : scope === 'batch' ? batchPlates : local && scope === 'all' ? allPlates : underTagged
  const planned = useMemo(() => planTagRun(plates, local && onlyUnderTagged, local ? Number(limit) : 25), [plates, local, onlyUnderTagged, limit])
  const count = planned.length
  const selectedModel = choice.data?.models.find(model => model.id === choice.modelId)
  return (
    <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button data-run-trigger onClick={() => { if (selectedPlates.length) setScope('selected') }} ref={trigger} disabled={disabled || !!disabledReason} title={disabledReason}>
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
            <Button size="sm" variant={scope === 'selected' ? 'primary' : 'outline'} aria-pressed={scope === 'selected'} disabled={!selectedPlates.length} onClick={() => setScope('selected')}>Selected plates {selectedPlates.length}</Button>
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
              aria-label={local ? `All of ${stateName} ${allPlates.length}` : `All of ${stateName}: Coming soon`}
            >
              All of {stateName} {local ? allPlates.length : '· Coming soon'}
            </Button>
            <Button size="sm" variant="ghost" disabled>
              + Add plates from any state · {local ? 'Use the existing cross-state selection' : 'Coming soon'}
            </Button>
          </div>
          {!local && plates.length > 25 ? (
            <p className="caption">First 25 of {plates.length}</p>
          ) : null}
        </fieldset>
        {local ? <fieldset className="grid gap-2">
          <legend className="label">Run options</legend>
          <label className="caption flex items-center gap-2">
            Limit
            <input aria-label="Limit" type="number" min={1} max={25} step={1} value={limit} onChange={event => setLimit(event.target.value)} aria-invalid={!validLimit} className="w-20 rounded-[var(--radius-md)] bg-[var(--fill)] px-3 py-2 text-[var(--ink)]" />
          </label>
          <p className="caption">Up to 25 plates per run.</p>
          <p className="caption">{count} of {plates.length} plates match this run.</p>
          {!validLimit ? <p role="alert" className="caption">Enter a whole number from 1 to 25.</p> : null}
        </fieldset> : null}
        <section aria-label="Stages and their options" className="grid gap-1">
          <h2 className="label mb-1">Stages and their options</h2>
          {stages.map(([name, description, duration, ...options]) => (
            <fieldset
              key={name}
              disabled={name !== 'Tag'}
              className={cn(
                'rounded-[var(--radius-md)] p-4',
                options.length > 0 && 'bg-[var(--fill)]',
                name !== 'Tag' && 'text-[var(--ink-2)]',
              )}
            >
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  aria-label={name === 'Tag' ? 'Tag' : `${name}: ${local ? localStageReasons[name] : 'Coming soon'}`}
                  checked={name === 'Tag'}
                  onChange={() => {}}
                  className="accent-[var(--ink)]"
                />
                <div className="flex-1">
                  <strong>{name}</strong>
                  <p className="caption">{description}</p>
                </div>
                {name !== 'Tag' ? (
                  <span className="caption">{local ? localStageReasons[name] : 'Coming soon'}</span>
                ) : null}
                <span className="id">{duration}</span>
              </div>
              {name === 'Tag' ? <TaggingModelPicker choice={choice} error={modelError} /> : null}
              {options.filter(option => !local || !option.startsWith('Limit')).map((option) => (
                <label
                  key={option}
                  className="mt-2 flex items-center gap-2 pr-1 pl-7 text-xs"
                >
                  <input
                    type="checkbox"
                    disabled={!local || option !== 'Only under-tagged plates'}
                    checked={local && option === 'Only under-tagged plates' ? onlyUnderTagged : false}
                    onChange={event => setOnlyUnderTagged(event.target.checked)}
                    aria-label={local && option === 'Only under-tagged plates' ? option : `${option}: ${local ? name === 'Tag' ? 'Needs confidence-based escalation' : localStageReasons[name] : 'Coming soon'}`}
                  />
                  {option}
                  <span className="ml-auto text-[var(--ink-2)]">
                    {local ? option === 'Only under-tagged plates' ? '' : name === 'Tag' ? 'Needs confidence-based escalation' : localStageReasons[name] : 'Coming soon'}
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
        </section>
        <footer className="sticky bottom-0 grid gap-3 border-t border-[var(--hairline)] bg-[var(--card)] pt-3 pb-5">
          <label className="caption flex gap-2">
            <input type="checkbox" disabled />
            Preview only · {local ? 'Needs a result-only run without Batch writes' : 'Coming soon'}
          </label>
          <p className="caption">
            {count} plates · Tag · about {Math.ceil((count * (selectedModel?.measured.p50Seconds ?? 40)) / 60)} min ·
            Suggestions land here for you to accept.
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={disabled || count === 0 || (local && !validLimit)}
              onClick={() => {
                start(planned, false, choice.modelId)
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
    {modelError && !open ? <p role="alert" className="caption">{modelError}</p> : null}
    </>
  )
}
