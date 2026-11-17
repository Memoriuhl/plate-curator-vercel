'use client'

import { useState } from 'react'
import { useTaggingModels } from '@/lib/client/hooks'
import { formatTaggingModel } from '@/lib/client/tagging-models'
import type { TaggingModelId } from '@/lib/tagging/models'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const storageKey = 'tagging-model:v1'

export function useTaggingModelChoice() {
  const { data } = useTaggingModels()
  const [choice, setChoice] = useState<string | null>(() => {
    try { return localStorage.getItem(storageKey) } catch { return null }
  })
  const modelId = (data?.models.find(model => model.id === choice)?.id ?? data?.default ?? undefined) as TaggingModelId | undefined
  function choose(id: string) {
    setChoice(id)
    try { localStorage.setItem(storageKey, id) } catch {}
  }
  return { data, modelId, choose }
}

export function TaggingModelPicker({ choice, error }: { choice: ReturnType<typeof useTaggingModelChoice>; error?: string }) {
  return <div className="grid min-w-0 gap-1">
    {choice.data && choice.data.models.length > 1 ? <Select value={choice.modelId} onValueChange={choice.choose}>
      <SelectTrigger size="sm" aria-label="Tagging model" className="min-w-0 max-w-full whitespace-nowrap [&_[data-slot=select-value]]:block [&_[data-slot=select-value]]:truncate"><SelectValue /></SelectTrigger>
      <SelectContent>{choice.data.models.map(model => <SelectItem key={model.id} value={model.id}>{formatTaggingModel(model)}</SelectItem>)}</SelectContent>
    </Select> : null}
    {error ? <p role="alert" className="caption">{error}</p> : null}
  </div>
}
