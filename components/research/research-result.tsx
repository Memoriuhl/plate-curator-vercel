'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { ResearchDraft, ResearchResult as Result } from '@/lib/research/types'

type Field = 'description' | 'funFacts' | 'readMore' | 'wikiUrl'
const labels: Record<Field, string> = { description: 'Description', funFacts: 'Fun facts', readMore: 'Read-more links', wikiUrl: 'Wikipedia link' }
const textClass = 'w-full min-w-0 rounded-lg bg-[var(--fill)] p-3 text-sm'

export function ResearchResult({ result, pending, canEditDraft = false, onAccept }: { result: Result; pending: boolean; canEditDraft?: boolean; onAccept(fields: Field[], draft: ResearchDraft): void }) {
  const [draft, setDraft] = useState(() => structuredClone(result.draft))
  const [selected, setSelected] = useState<Field[]>([])
  const available = { description: !!draft.description, funFacts: draft.funFacts.length > 0, readMore: draft.readMore.length > 0, wikiUrl: !!draft.wikiSource }
  return <div className="grid min-w-0 gap-4">
    <p className="caption">{result.provenance.model} · {result.status} · {(result.durationMs / 1000).toFixed(1)}s · {result.cost.usd === null ? 'Cost unavailable' : `$${result.cost.usd.toFixed(4)} known cost`}{result.cost.missing ? ' · some costs unmeasured' : ''}</p>
    {!canEditDraft ? <p className="caption">Choose the stored fields to accept. Only an Owner can edit research text.</p> : null}
    <fieldset disabled={pending} className="grid gap-4">
      <legend className="label mb-3">Choose fields to accept into this Batch</legend>
      {(Object.keys(labels) as Field[]).map(field => <div key={field} className="grid min-w-0 gap-2">
        <label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={selected.includes(field)} disabled={!available[field]} onChange={event => setSelected(previous => event.target.checked ? [...previous, field] : previous.filter(item => item !== field))} />{labels[field]}</label>
        {field === 'description' && draft.description ? <><textarea aria-label="Edit description" readOnly={!canEditDraft} className={textClass} rows={4} value={draft.description} onChange={event => setDraft(previous => ({ ...previous, description: event.target.value }))} /><span className="caption">Sources: {draft.descriptionSources.join(', ')}</span></> : null}
        {field === 'funFacts' ? draft.funFacts.map((fact, index) => <label key={index} className="grid gap-1"><span className="caption">Fact {index + 1} · {fact.sourceId}</span><textarea aria-label={`Edit fact ${index + 1}`} readOnly={!canEditDraft} className={textClass} rows={2} value={fact.text} onChange={event => setDraft(previous => ({ ...previous, funFacts: previous.funFacts.map((item, at) => at === index ? { ...item, text: event.target.value } : item) }))} /></label>) : null}
        {field === 'readMore' ? <span className="caption">{draft.readMore.join(', ') || 'No fetched links'}</span> : null}
        {field === 'wikiUrl' ? <span className="caption">{draft.wikiSource ?? 'No Wikipedia source'}</span> : null}
      </div>)}
      <Button disabled={!selected.length || pending} onClick={() => onAccept(selected, draft)}>Accept selected fields</Button>
    </fieldset>
    <details><summary className="cursor-pointer label">Fetched sources ({result.sources.length})</summary><div className="grid min-w-0 gap-3 pt-3">{result.sources.map(source => <div key={source.id} className="min-w-0"><a className="break-words underline" href={source.url} target="_blank" rel="noreferrer">{source.id} · {source.title}</a><p className="caption break-all">{source.url}</p><details><summary className="caption cursor-pointer">Read captured evidence</summary><p className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">{source.text}</p></details></div>)}</div></details>
    {result.rejected.length ? <p className="caption">Screened out: {result.rejected.map(item => `${item.field}: ${item.reason}`).join('; ')}</p> : null}
  </div>
}
