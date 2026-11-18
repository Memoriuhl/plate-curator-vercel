'use client'

import { useState } from 'react'
import { IoCloudOutline, IoLaptopOutline } from 'react-icons/io5'
import useSWR from 'swr'
import { useSession } from '@/lib/client/session'
import type { ResearchModel } from '@/lib/research/models'
import { InlineSelect } from '@/components/ui/inline-select'

const storageKey = 'research-model:v1'
const catalogUrl = '/api/research/models'

export function researchModelLabel(model: ResearchModel) {
  const execution =
    model.executor === 'desktop'
      ? 'On-device worker (Ollama)'
      : 'Hosted research (Eve)'
  return `${execution} · ${model.label}`
}

/**
 * Resolve the available research models and retain the curator's valid model preference.
 */
export function useResearchModelChoice() {
  const { api, user } = useSession()
  const { data, error, isLoading, mutate } = useSWR<{
    models: ResearchModel[]
    default?: string
  }>(user ? ([catalogUrl, user.uid] as const) : null, ([url]) => api.get(url))
  const [choice, setChoice] = useState<string | null>(() => {
    try {
      return localStorage.getItem(storageKey)
    } catch {
      return null
    }
  })
  const models = error ? [] : (data?.models ?? [])
  const model =
    models.find((model) => model.id === choice) ??
    models.find((model) => model.id === data?.default) ??
    models[0]
  /**
   * Update the selected research model and remember it when browser storage is
   * available.
   */
  function choose(id: string) {
    setChoice(id)
    try {
      localStorage.setItem(storageKey, id)
    } catch {}
  }
  return { models, model, error, isLoading, reload: mutate, choose }
}

/** Render the research model selector and identify where its results will be saved. */
export function ResearchModelPicker({
  choice,
}: {
  choice: ReturnType<typeof useResearchModelChoice>
}) {
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
