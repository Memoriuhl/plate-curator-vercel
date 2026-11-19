'use client'

import { IoCloudOutline, IoLaptopOutline } from 'react-icons/io5'
import useSWR from 'swr'
import { useSession } from '@/lib/client/session'
import {
  DEFAULT_HOSTED_RESEARCH_MODEL,
  researchModel,
  type ResearchModel,
} from '@/lib/research/models'
import type { HostedModelCatalog } from '@/lib/models/selection'
import {
  eligiblePickerModel,
  HostedModelPicker,
  useModelPreference,
} from './hosted-model-picker'
import { InlineSelect } from '@/components/ui/inline-select'

const storageKey = 'research-model:v1'
const catalogUrl = '/api/research/models'

export function researchModelLabel(
  model: Pick<ResearchModel, 'executor' | 'label'>
) {
  const execution =
    model.executor === 'desktop'
      ? 'On-device worker (Ollama)'
      : 'Hosted research (Eve)'
  return `${execution} · ${model.label}`
}

/**
 * Resolve the available research models and retain the curator's valid model preference.
 */
export function useResearchModelChoice(hostedOnly = false) {
  const { api, user } = useSession()
  const { data, error, isLoading, mutate } = useSWR<{
    models: ResearchModel[]
    default?: string
    hosted?: HostedModelCatalog
  }>(user ? ([catalogUrl, user.uid] as const) : null, ([url]) => api.get(url))
  const hosted = error ? undefined : data?.hosted
  const preference = useModelPreference(storageKey, hosted)
  const models = (error ? [] : (data?.models ?? [])).filter(
    (model) => !hostedOnly || model.executor === 'eve'
  )
  const local = models.filter((model) => model.executor === 'desktop')
  const hostedPick = eligiblePickerModel(
    hosted,
    researchModel(preference.id)?.model ?? preference.id,
    preference.options.capUsd
  )
  const preferred =
    hostedPick ??
    (hostedOnly
      ? (eligiblePickerModel(
          hosted,
          DEFAULT_HOSTED_RESEARCH_MODEL,
          preference.options.capUsd
        ) ??
        hosted?.curated.find(({ id }) =>
          eligiblePickerModel(hosted, id, preference.options.capUsd)
        ))
      : undefined)
  const model =
    (preferred && {
      id: preferred.id,
      label: preferred.label,
      model: preferred.id,
      executor: 'eve' as const,
    }) ??
    (hosted ? local : models).find((model) => model.id === preference.id) ??
    (hosted ? local : models).find((model) => model.id === data?.default) ??
    (hosted ? local : models)[0]
  function choose(id: string) {
    preference.update({ id })
  }
  return {
    models,
    local,
    model,
    hosted,
    modelOptions: preferred ? preference.options : undefined,
    preference,
    error,
    isLoading,
    reload: mutate,
    choose,
  }
}

/** Render the research model selector and identify where its results will be saved. */
export function ResearchModelPicker({
  choice,
}: {
  choice: ReturnType<typeof useResearchModelChoice>
}) {
  if (choice.hosted)
    return (
      <HostedModelPicker
        label="Research model"
        catalog={choice.hosted}
        localModels={choice.local.map((model) => ({
          ...model,
          label: researchModelLabel(model),
        }))}
        selected={choice.model}
        options={choice.preference.options}
        onChange={choice.choose}
        onOptionsChange={choice.preference.update}
      />
    )
  return (
    <div className="grid gap-1">
      <p className="label">Research model</p>
      {choice.error ? (
        <p role="alert" className="caption">
          Could not load research models.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => void choice.reload().catch(() => undefined)}
          >
            Retry
          </button>
        </p>
      ) : choice.isLoading ? (
        <p role="status" className="caption">
          Loading research models…
        </p>
      ) : !choice.model ? (
        <p role="status" className="caption">
          No research models are available.
        </p>
      ) : (
        <InlineSelect
          label="Research model"
          value={choice.model.id}
          onChange={choice.choose}
          options={choice.models.map((model) => ({
            value: model.id,
            label: researchModelLabel(model),
            icon:
              model.executor === 'desktop' ? IoLaptopOutline : IoCloudOutline,
          }))}
        />
      )}
    </div>
  )
}
