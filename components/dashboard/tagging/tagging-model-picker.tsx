'use client'

import { IoCloudOutline, IoLaptopOutline } from 'react-icons/io5'
import { useTaggingModels } from '@/lib/client/hooks'
import { formatTaggingModel } from '@/lib/client/tagging-models'
import { InlineSelect } from '@/components/ui/inline-select'
import { taggingModel } from '@/lib/tagging/models'
import {
  eligiblePickerModel,
  HostedModelPicker,
  useModelPreference,
} from '../hosted-model-picker'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/** Resolve an available tagging model from the saved or default selection. */
export function useTaggingModelChoice(storageKey = 'tagging-model:v1') {
  const { data } = useTaggingModels()
  const hosted = storageKey === 'tagging-model:v1' ? data?.hosted : undefined
  const preference = useModelPreference(storageKey, hosted)
  const local = data?.models.filter((model) => model.runsOn === 'desktop') ?? []
  const active = hosted ? local : (data?.models ?? [])
  const saved = active.find((model) => model.id === preference.id)
  const selectedHosted =
    eligiblePickerModel(
      hosted,
      taggingModel(preference.id)?.model ?? preference.id,
      preference.options.capUsd
    ) ??
    (!saved && preference.id === null
      ? eligiblePickerModel(
          hosted,
          taggingModel(data?.default)?.model,
          preference.options.capUsd
        )
      : undefined) ??
    (!local.length
      ? hosted?.curated.find(({ id }) =>
          eligiblePickerModel(hosted, id, preference.options.capUsd)
        )
      : undefined)
  const selected =
    selectedHosted ??
    saved ??
    active.find((model) => model.id === data?.default) ??
    active[0]
  function choose(id: string) {
    preference.update({ id })
  }
  return {
    data,
    modelId: selected?.id,
    hosted,
    preference,
    selected,
    modelOptions: selectedHosted ? preference.options : undefined,
    choose,
  }
}

/** Render tagging model options with their cost and any current error. */
export function TaggingModelPicker({
  choice,
  error,
  inlineLabel,
}: {
  choice: Pick<ReturnType<typeof useTaggingModelChoice>, 'data' | 'choose'> &
    Partial<
      Pick<
        ReturnType<typeof useTaggingModelChoice>,
        'hosted' | 'preference' | 'selected'
      >
    > & {
      modelId?: string
    }
  error?: string
  inlineLabel?: string
}) {
  const models = choice.data?.models ?? []
  return (
    <div className="grid min-w-0 gap-1">
      {choice.hosted && choice.preference ? (
        <HostedModelPicker
          label={inlineLabel ?? 'Tagging model'}
          catalog={choice.hosted}
          localModels={models
            .filter((model) => model.runsOn === 'desktop')
            .map((model) => ({ ...model, label: formatTaggingModel(model) }))}
          selected={choice.selected}
          options={choice.preference.options}
          onChange={choice.choose}
          onOptionsChange={choice.preference.update}
        />
      ) : (
        models.length > 1 &&
        (inlineLabel ? (
          <InlineSelect
            label={inlineLabel}
            value={choice.modelId}
            onChange={choice.choose}
            options={models.map((model) => ({
              value: model.id,
              label: formatTaggingModel(model),
              icon:
                model.runsOn === 'desktop' ? IoLaptopOutline : IoCloudOutline,
            }))}
          />
        ) : (
          <Select value={choice.modelId} onValueChange={choice.choose}>
            <SelectTrigger
              size="sm"
              aria-label="Tagging model"
              className="min-w-0 max-w-full whitespace-nowrap [&_[data-slot=select-value]]:block [&_[data-slot=select-value]]:truncate"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {formatTaggingModel(model)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ))
      )}
      {error ? (
        <p role="alert" className="caption">
          {error}
        </p>
      ) : null}
    </div>
  )
}
