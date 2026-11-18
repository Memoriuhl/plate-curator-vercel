'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useSession } from '@/lib/client/session'
import type { ResearchModel } from '@/lib/research/models'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const storageKey = 'research-model:v1'
export function useResearchModelChoice() {
  const { api, user } = useSession()
  const { data } = useSWR<{ models: ResearchModel[]; default?: string }>(user ? '/api/research/models' : null, api.get)
  const [choice, setChoice] = useState<string | null>(() => { try { return localStorage.getItem(storageKey) } catch { return null } })
  const modelId = data?.models?.find(model => model.id === choice)?.id ?? data?.default
  function choose(id: string) { setChoice(id); try { localStorage.setItem(storageKey, id) } catch {} }
  return { models: data?.models ?? [], modelId, choose }
}

export function ResearchModelPicker({ choice }: { choice: ReturnType<typeof useResearchModelChoice> }) {
  return <div className="grid gap-1"><p className="label">Research model</p>
    <Select value={choice.modelId} onValueChange={choice.choose}><SelectTrigger size="sm" aria-label="Research model" className="min-w-0 max-w-full"><SelectValue placeholder="Loading research models…" /></SelectTrigger>
      <SelectContent>{choice.models.map(model => <SelectItem key={model.id} value={model.id}>{model.label} · {model.executor === 'desktop' ? 'Desktop / Ollama' : 'Vercel / Eve'}</SelectItem>)}</SelectContent>
    </Select>
    <p className="caption">Research has its own model choice. Captured sources are reused for one synthesis call per plate; results remain drafts.</p>
  </div>
}
