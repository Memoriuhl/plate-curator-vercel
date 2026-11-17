'use client'

import { useRef, useState } from 'react'
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
  batchPlates,
  stateName,
  disabled,
  disabledReason,
  start,
  modelError,
}: {
  underTagged: RunPlate[]
  batchPlates: RunPlate[]
  stateName: string
  disabledReason?: string
  disabled: boolean
  modelError?: string
  start(plates: RunPlate[], retry: boolean, modelId?: TaggingModelId): void
}) {
  const choice = useTaggingModelChoice()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const [scope, setScope] = useState('under')
  const plates = scope === 'batch' ? batchPlates : underTagged
  const count = Math.min(25, plates.length)
  const selectedModel = choice.data?.models.find(model => model.id === choice.modelId)
  return (
    <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button ref={trigger} disabled={disabled || !!disabledReason} title={disabledReason}>
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
        className="max-h-[min(85dvh,var(--radix-popover-content-available-height))] w-[580px] max-w-[100vw] gap-4 overflow-y-auto rounded-[var(--radius-lg)] bg-[var(--card)] px-5 pt-5 pb-0 text-[var(--ink)] shadow-xl [&>*]:shrink-0 max-[420px]:w-screen max-[420px]:rounded-none"
      >
        <fieldset className="grid gap-2">
          <legend className="label mb-2">Run on</legend>
          <div className="flex flex-wrap gap-2">
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
              variant="ghost"
              disabled
              aria-label={`All of ${stateName}: Coming soon`}
            >
              All of {stateName} · Coming soon
            </Button>
            <Button size="sm" variant="ghost" disabled>
              + Add plates from any state · Coming soon
            </Button>
          </div>
          {plates.length > 25 ? (
            <p className="caption">First 25 of {plates.length}</p>
          ) : null}
        </fieldset>
        <section aria-label="Stages and their options" className="grid gap-1">
          <h2 className="label mb-1">Stages and their options</h2>
          {stages.map(([name, description, duration, ...options]) => (
            <fieldset
              key={name}
              disabled={name !== 'Tag'}
              className={cn(
                'rounded-xl p-3',
                options.length > 0 && 'bg-[var(--fill)]',
                name !== 'Tag' && 'text-[var(--ink-2)]',
              )}
            >
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  aria-label={name === 'Tag' ? 'Tag' : `${name}: Coming soon`}
                  checked={name === 'Tag'}
                  onChange={() => {}}
                  className="accent-[var(--ink)]"
                />
                <div className="flex-1">
                  <strong>{name}</strong>
                  <p className="caption">{description}</p>
                </div>
                {name !== 'Tag' ? (
                  <span className="caption">Coming soon</span>
                ) : null}
                <span className="id">{duration}</span>
              </div>
              {name === 'Tag' ? <TaggingModelPicker choice={choice} error={modelError} /> : null}
              {options.map((option) => (
                <label
                  key={option}
                  className="mt-2 flex items-center gap-2 pl-6 text-xs"
                >
                  <input
                    type="checkbox"
                    disabled
                    aria-label={`${option}: Coming soon`}
                  />
                  {option}
                  <span className="ml-auto text-[var(--ink-2)]">
                    Coming soon
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
        </section>
        <footer className="sticky bottom-0 grid gap-3 border-t border-[var(--hairline)] bg-[var(--card)] pt-3 pb-5">
          <label className="caption flex gap-2">
            <input type="checkbox" disabled />
            Preview only · Coming soon
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
              disabled={disabled || count === 0}
              onClick={() => {
                start(plates.slice(0, 25), false, choice.modelId)
                setOpen(false)
              }}
            >
              <IoPlay aria-hidden="true" />
              Start run
            </Button>
          </div>
          <Button size="sm" variant="outline" disabled>
            Queue · Coming soon
          </Button>
        </footer>
      </PopoverContent>
    </Popover>
    {modelError && !open ? <p role="alert" className="caption">{modelError}</p> : null}
    </>
  )
}
