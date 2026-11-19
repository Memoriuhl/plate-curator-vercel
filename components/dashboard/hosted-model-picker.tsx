'use client'

import { useRef, useState, useSyncExternalStore } from 'react'
import {
  IoChevronDownOutline,
  IoCheckmarkOutline,
  IoCloudOutline,
  IoDesktopOutline,
} from 'react-icons/io5'
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorTrigger,
} from '@/components/ai-elements/model-selector'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DEFAULT_MODEL_CAP,
  fitsModelCap,
  modelOptionsSchema,
  type HostedModelCatalog,
  type ModelCap,
  type PickerModel,
} from '@/lib/models/selection'

type Preference = { id: string | null; capUsd: ModelCap; strict: boolean }
const defaultPreference: Preference = {
  id: null,
  capUsd: DEFAULT_MODEL_CAP,
  strict: false,
}
const subscribeToHydration = () => () => {}

export function useModelPreference(
  key: string,
  catalog: HostedModelCatalog | undefined
) {
  const [savedPreference, setPreference] = useState<Preference>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return defaultPreference
      // Previous pickers stored the ID directly.
      if (!raw.startsWith('{')) return { ...defaultPreference, id: raw }
      const { id, capUsd, strict } = JSON.parse(raw)
      const options = modelOptionsSchema.safeParse({ capUsd, strict })
      return {
        id: typeof id === 'string' ? id : null,
        capUsd: options.data?.capUsd ?? DEFAULT_MODEL_CAP,
        strict: options.data?.strict ?? false,
      }
    } catch {
      return defaultPreference
    }
  })
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false
  )
  const preference = hydrated ? savedPreference : defaultPreference
  const cap = catalog?.caps.includes(preference.capUsd)
    ? preference.capUsd
    : (catalog?.caps.filter((preset) => preset <= DEFAULT_MODEL_CAP).at(-1) ??
      catalog?.caps[0] ??
      DEFAULT_MODEL_CAP)
  const options = { capUsd: cap, strict: preference.strict }
  const update = (changes: Partial<Preference>) => {
    const next = { ...preference, ...options, ...changes }
    setPreference(next)
    try {
      localStorage.setItem(
        key,
        next.id && next.capUsd === DEFAULT_MODEL_CAP && !next.strict
          ? next.id
          : JSON.stringify(next)
      )
    } catch {}
  }
  return { id: preference.id, options, update }
}

export function eligiblePickerModel(
  catalog: HostedModelCatalog | undefined,
  id: string | null | undefined,
  cap: ModelCap
) {
  const choices = catalog?.unavailable ? catalog.curated : catalog?.searchable
  return choices?.find(
    (model) => model.id === id && fitsModelCap(model.estimatedUsd, cap)
  )
}

const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 6,
})

function ModelMetrics({ model }: { model: PickerModel }) {
  const metrics = model.measured
  return (
    <span className="caption flex flex-wrap gap-x-2">
      <span>{dollars.format(model.estimatedUsd)} / plate est.</span>
      {metrics ? (
        <>
          <span>
            {metrics.f1 !== undefined
              ? `F1 ${metrics.f1.toFixed(3)}`
              : `${Math.round((metrics.fillRate ?? 0) * 100)}% filled`}
          </span>
          <span>{metrics.p50Seconds}s p50</span>
          {metrics.costPerPlate !== null && (
            <span>{dollars.format(metrics.costPerPlate)} / plate measured</span>
          )}
        </>
      ) : (
        <span>untested</span>
      )}
    </span>
  )
}

/** Show whether a model runs on an on-device worker or in the cloud. */
function ModelHost({ device }: { device: boolean }) {
  const Icon = device ? IoDesktopOutline : IoCloudOutline
  return (
    <span
      data-model-host={device ? 'device' : 'cloud'}
      className="inline-flex shrink-0 text-[var(--ink-2)]"
    >
      <Icon className="chrome-icon" aria-hidden="true" />
    </span>
  )
}

export function HostedModelPicker({
  label,
  catalog,
  localModels,
  selected,
  options,
  onChange,
  onOptionsChange,
}: {
  label: string
  catalog: HostedModelCatalog
  localModels: { id: string; label: string }[]
  selected?: { id: string; label: string }
  options: ReturnType<typeof useModelPreference>['options']
  onChange(id: string): void
  onOptionsChange(
    options: Partial<ReturnType<typeof useModelPreference>['options']>
  ): void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const selectedHosted = eligiblePickerModel(
    catalog,
    selected?.id,
    options.capUsd
  )
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const matches = (model: { label: string; id: string }) =>
    terms.every((term) =>
      `${model.label} ${model.id}`.toLowerCase().includes(term)
    )
  const eligible = (model: PickerModel) =>
    fitsModelCap(model.estimatedUsd, options.capUsd) && matches(model)
  const curated = catalog.curated.filter(eligible)
  const desktop = localModels.filter(matches)
  const curatedIds = new Set(curated.map(({ id }) => id))
  const providers = Map.groupBy(
    terms.length
      ? catalog.searchable.filter(
          (model) => eligible(model) && !curatedIds.has(model.id)
        )
      : [],
    (model) => model.provider
  )
  function item(model: { id: string; label: string }, hosted?: PickerModel) {
    return (
      <ModelSelectorItem
        key={model.id}
        value={model.id}
        onSelect={() => {
          onChange(model.id)
          setOpen(false)
          setQuery('')
        }}
      >
        <ModelHost device={!hosted} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <strong className="break-words">{model.label}</strong>
          {hosted && <ModelMetrics model={hosted} />}
        </span>
        {model.id === selected?.id && (
          <>
            <IoCheckmarkOutline
              className="chrome-icon shrink-0"
              aria-hidden="true"
            />
            <span className="sr-only">Current model</span>
          </>
        )}
      </ModelSelectorItem>
    )
  }

  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <ModelSelector
          open={open}
          onOpenChange={(value) => {
            setOpen(value)
            if (!value) setQuery('')
          }}
        >
          <ModelSelectorTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`${label}: ${selected?.label ?? 'Choose model'}`}
              className="w-fit max-w-full"
            >
              {selected && (
                <ModelHost
                  device={localModels.some(({ id }) => id === selected.id)}
                />
              )}
              <span className="truncate">
                {label} · {selected?.label ?? 'Choose model'}
              </span>
              <IoChevronDownOutline
                className="chrome-icon"
                aria-hidden="true"
              />
            </Button>
          </ModelSelectorTrigger>
          <ModelSelectorContent
            title={label}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              input.current?.focus()
            }}
            controls={
              <label className="flex flex-wrap items-center gap-2 text-sm">
                Price cap per plate
                <select
                  value={options.capUsd}
                  className="h-8 rounded-full bg-muted px-3 focus-visible:outline-2 focus-visible:outline-primary"
                  onChange={(event) =>
                    onOptionsChange({
                      capUsd: Number(event.target.value) as ModelCap,
                    })
                  }
                >
                  {catalog.caps.map((cap) => (
                    <option key={cap} value={cap}>
                      {dollars.format(cap)}
                    </option>
                  ))}
                </select>
              </label>
            }
          >
            <ModelSelectorInput
              ref={input}
              placeholder={
                catalog.unavailable ? 'Catalog unavailable' : 'Search models'
              }
              readOnly={catalog.unavailable}
              value={query}
              onValueChange={setQuery}
            />
            <ModelSelectorList>
              <ModelSelectorEmpty>
                {catalog.unavailable
                  ? 'No available models under this cap.'
                  : terms.length
                    ? 'No models match this search and cap.'
                    : 'No models under this cap. Search the catalog or raise the cap.'}
              </ModelSelectorEmpty>
              {desktop.length > 0 && (
                <ModelSelectorGroup heading="On-device workers">
                  {desktop.map((model) => item(model))}
                </ModelSelectorGroup>
              )}
              {curated.length > 0 && (
                <ModelSelectorGroup
                  heading={catalog.unavailable ? 'Pinned default' : 'Curated'}
                >
                  {curated.map((model) => item(model, model))}
                </ModelSelectorGroup>
              )}
              {[...providers].map(([provider, models]) => (
                <ModelSelectorGroup key={provider} heading={provider}>
                  {models.map((model) => item(model, model))}
                </ModelSelectorGroup>
              ))}
            </ModelSelectorList>
          </ModelSelectorContent>
        </ModelSelector>
        {selectedHosted && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <label className="flex w-fit items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={options.strict}
                    onChange={(event) =>
                      onOptionsChange({ strict: event.target.checked })
                    }
                  />
                  Strict model
                </label>
              </TooltipTrigger>
              <TooltipContent>
                Use only this model. If it fails, the plate fails instead of
                switching to the default model.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      {catalog.unavailable && (
        <p role="status" className="caption">
          Hosted model catalog unavailable.
        </p>
      )}
      {selectedHosted && (
        <span className="caption">
          {dollars.format(selectedHosted.estimatedUsd)} / plate est.
        </span>
      )}
    </div>
  )
}
