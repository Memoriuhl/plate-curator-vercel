'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import type { StoryFields } from '@/lib/catalog/types'
import type { EditableFields } from '@/lib/review/types'
import { parseEditableFields } from '@/lib/review/fields'
import { changedStoryFields } from '@/lib/review/story'

const input = 'w-full min-w-0 rounded-[var(--radius-md)] bg-[var(--fill)] px-3 py-2 text-[var(--ink)]'

export function StoryEditor({ plate, pending, save }: {
  plate: PlateCardData & StoryFields
  pending: boolean
  save(target: PlateCardData, fields: EditableFields): Promise<boolean>
}) {
  const [target] = useState(plate)
  const [draft, setDraft] = useState<StoryFields>(() => ({
    firstIssuedYear: plate.firstIssuedYear ?? null,
    funFacts: plate.funFacts ?? [], readMore: plate.readMore ?? [],
    sourceUrl: plate.sourceUrl ?? null, wikiUrl: plate.wikiUrl ?? null,
  }))
  const [saved, setSaved] = useState(false)
  const changes = changedStoryFields(target, draft)
  const dirty = Object.keys(changes).length > 0
  const valid = !dirty || parseEditableFields(changes) !== null
  function change(fields: StoryFields) {
    setSaved(false)
    setDraft(previous => ({ ...previous, ...fields }))
  }
  return <form onSubmit={async event => {
    event.preventDefault()
    if (!pending && valid && dirty) setSaved(await save(target, changes))
  }} className="grid gap-[var(--stack-gap)]">
    <fieldset disabled={pending} className="grid min-w-0 gap-[var(--stack-gap)]">
      <legend className="sr-only">Edit sourced story</legend>
      <label className="grid gap-2">First issued year
        <input aria-label="First issued year" className={input} type="number" min={1800} max={2100} step={1} value={draft.firstIssuedYear ?? ''} onChange={event => change({ firstIssuedYear: event.target.value === '' ? null : Number(event.target.value) })} />
      </label>
      {(['sourceUrl', 'wikiUrl'] as const).map(key => <label key={key} className="grid gap-2">
        {key === 'wikiUrl' ? 'Wiki URL' : 'Source URL'}
        <input aria-label={key === 'wikiUrl' ? 'Wiki URL' : 'Source URL'} type="url" maxLength={2048} className={input} value={draft[key] ?? ''} onChange={event => change({ [key]: event.target.value || null })} />
      </label>)}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="label">Fun facts {draft.funFacts!.length} / 4</h3>
        <Button type="button" size="sm" variant="outline" disabled={draft.funFacts!.length >= 4} onClick={() => change({ funFacts: [...draft.funFacts!, { text: '', sourceUrl: '' }] })}>Add fact</Button>
      </div>
      {draft.funFacts!.map((fact, index) => <fieldset key={index} className="grid min-w-0 gap-2 rounded-[var(--radius-md)] bg-[var(--card)] p-3">
        <legend className="label">Fact {index + 1}</legend>
        {(['text', 'sourceUrl', 'sourceTitle'] as const).map(key => <label key={key} className="grid gap-2">
          {key === 'text' ? 'Fact' : key === 'sourceUrl' ? 'Source URL' : 'Source title (optional)'}
          <input aria-label={`Fact ${index + 1} ${key}`} required={key !== 'sourceTitle'} type={key === 'sourceUrl' ? 'url' : 'text'} maxLength={key === 'text' ? 500 : key === 'sourceUrl' ? 2048 : 200} className={input} value={fact[key] ?? ''} onChange={event => change({ funFacts: draft.funFacts!.map((item, at) => at === index ? { ...item, [key]: event.target.value || (key === 'sourceTitle' ? undefined : '') } : item) })} />
        </label>)}
        <Button type="button" size="sm" variant="ghost" onClick={() => change({ funFacts: draft.funFacts!.filter((_, at) => at !== index) })}>Remove fact {index + 1}</Button>
      </fieldset>)}
      <p className="caption">Every fact needs its source URL. Uncited facts cannot be saved.</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="label">Sources and read-more {draft.readMore!.length} / 8</h3>
        <Button type="button" size="sm" variant="outline" disabled={draft.readMore!.length >= 8} onClick={() => change({ readMore: [...draft.readMore!, { title: '', site: '', url: '' }] })}>Add link</Button>
      </div>
      {draft.readMore!.map((link, index) => <fieldset key={index} className="grid min-w-0 gap-2 rounded-[var(--radius-md)] bg-[var(--card)] p-3">
        <legend className="label">Link {index + 1}</legend>
        {(['title', 'site', 'url'] as const).map(key => <label key={key} className="grid gap-2">{key === 'url' ? 'URL' : key === 'title' ? 'Title' : 'Site'}
          <input aria-label={`Link ${index + 1} ${key}`} type={key === 'url' ? 'url' : 'text'} required={key !== 'site'} maxLength={key === 'url' ? 2048 : 200} className={input} value={link[key]} onChange={event => change({ readMore: draft.readMore!.map((item, at) => at === index ? { ...item, [key]: event.target.value } : item) })} />
        </label>)}
        <Button type="button" size="sm" variant="ghost" onClick={() => change({ readMore: draft.readMore!.filter((_, at) => at !== index) })}>Remove link {index + 1}</Button>
      </fieldset>)}
      {!valid ? <p role="alert" className="caption">Use a year from 1800 to 2100, bounded text, and HTTP or HTTPS source links.</p> : null}
      <Button type="submit" disabled={!valid || !dirty || saved}>Save story to Batch</Button>
    </fieldset>
    {saved ? <p role="status">Story saved to your Batch.</p> : null}
  </form>
}
