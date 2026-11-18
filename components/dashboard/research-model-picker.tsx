'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useSession } from '@/lib/client/session'
import type { ResearchModel } from '@/lib/research/models'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const storageKey = 'research-model:v1'
const catalogUrl = '/api/research/models'

export function researchModelLabel(model: ResearchModel) {
  const execution = model.executor === 'desktop' ? 'On-device worker (Ollama)' : 'Hosted research (Eve)'
  return `${execution} · ${model.label}`
}

export function useResearchModelChoice() {
  const { api, user } = useSession()
  const { data, error, isLoading, mutate } = useSWR<{ models: ResearchModel[]; default?: string }>(
    user ? [catalogUrl, user.uid] as const : null, ([url]) => api.get(url),
  )
  const [choice, setChoice] = useState<string | null>(() => { try { return localStorage.getItem(storageKey) } catch { return null } })
  const models = error ? [] : data?.models ?? []
  const model = models.find(model => model.id === choice) ?? models.find(model => model.id === data?.default) ?? models[0]
  function choose(id: string) { setChoice(id); try { localStorage.setItem(storageKey, id) } catch {} }
  return { models, model, error, isLoading, reload: mutate, choose }
}

export function ResearchModelPicker({ choice }: { choice: ReturnType<typeof useResearchModelChoice> }) {
  return <div className="grid gap-1">
    <p className="label">Research model</p>
    {choice.error ? <p role="alert" className="caption">Could not load research models. <button type="button" className="underline" onClick={() => void choice.reload().catch(() => undefined)}>Retry</button></p>
      : choice.isLoading ? <p role="status" className="caption">Loading research models…</p>
      : !choice.model ? <p role="status" className="caption">No research models are available.</p>
      : <Select value={choice.model.id} onValueChange={choice.choose}>
        <SelectTrigger size="sm" aria-label="Research model" className="min-w-0 max-w-full"><SelectValue /></SelectTrigger>
        <SelectContent position="popper" align="start" sideOffset={4}>
          {choice.models.map(model => <SelectItem key={model.id} value={model.id}>{researchModelLabel(model)}</SelectItem>)}
        </SelectContent>
      </Select>}
  </div>
}
