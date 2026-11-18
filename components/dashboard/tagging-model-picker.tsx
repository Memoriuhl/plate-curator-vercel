'use client'

import { useState } from 'react'
import { IoCloudOutline, IoLaptopOutline } from 'react-icons/io5'
import { useTaggingModels } from '@/lib/client/hooks'
import { formatTaggingModel } from '@/lib/client/tagging-models'
import { InlineSelect } from '@/components/ui/inline-select'
import type { TaggingModelId } from '@/lib/tagging/models'
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
  const [choice, setChoice] = useState<string | null>(() => {
    try {
      return localStorage.getItem(storageKey)
    } catch {
      return null
    }
  })
  const modelId = (data?.models.find((model) => model.id === choice)?.id ??
    data?.default ??
    undefined) as TaggingModelId | undefined
  /** Update the active tagging model and persist the choice when storage is available. */
  function choose(id: string) {
    setChoice(id)
    try {
      localStorage.setItem(storageKey, id)
    } catch {}
  }
  return { data, modelId, choose }
}

/** Render tagging model options with their cost and any current error. */
export function TaggingModelPicker({
  choice,
  error,
  inlineLabel,
}: {
  choice: Pick<ReturnType<typeof useTaggingModelChoice>, 'data' | 'choose'> & {
    modelId?: string
  }
  error?: string
  inlineLabel?: string
}) {
  const models = choice.data?.models ?? []
  return (
    <div className="grid min-w-0 gap-1">
      {models.length > 1 &&
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
        ))}
      {error ? (
        <p role="alert" className="caption">
          {error}
        </p>
      ) : null}
    </div>
  )
}
