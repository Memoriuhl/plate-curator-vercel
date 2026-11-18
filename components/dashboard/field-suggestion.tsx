'use client'

import { Button } from '@/components/ui/button'
import type { Plate } from '@/lib/catalog/types'
import type { FieldsSuggestion as Suggestion } from '@/lib/jobs/types'

/** Format a field suggestion for inspection, including missing and structured values. */
const show = (value: unknown) => value == null ? 'None' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)
const labels: Record<string, string> = { description: 'Description', funFacts: 'Fun facts', firstIssuedYear: 'First issued year', readMore: 'Read more', wikiUrl: 'Wiki link', colorDetail: 'Background color', lineageColor: 'Broad color', tags: 'Tags', templateFamily: 'Family', templateRole: 'Role', variantOfPlateId: 'Variant of' }

/** Show the proposed stage fields and the available action for applying them. */
export function FieldSuggestion({ suggestion, before, blocked, accepted, inspectOnly = false, accept }: {
  suggestion: Suggestion
  before?: Plate
  blocked: boolean
  accepted: boolean
  inspectOnly?: boolean
  accept(): void
}) {
  return <div className="grid min-w-0 gap-[var(--stack-gap)]">
    <strong className="capitalize">{suggestion.stage.replaceAll('-', ' ')} suggestion</strong>
    <dl className="grid min-w-0 gap-3">
      {Object.entries(suggestion.fields).map(([key, value]) => <div key={key} className="grid min-w-0 gap-2">
        <dt className="label">{labels[key] ?? key}</dt>
        <dd className="grid min-w-0 gap-2 sm:grid-cols-2">
          <div><span className="caption">Current</span><pre className="whitespace-pre-wrap break-words font-sans text-sm [overflow-wrap:anywhere]">{show(before?.[key])}</pre></div>
          <div><span className="caption">Suggested</span><pre className="whitespace-pre-wrap break-words font-sans text-sm [overflow-wrap:anywhere]">{show(value)}</pre></div>
        </dd>
      </div>)}
    </dl>
    <div className="grid gap-2" aria-label="Suggestion sources">
      {suggestion.sources.map(source => <a key={source} href={source} target="_blank" rel="noreferrer" className="caption break-all underline">{source}</a>)}
    </div>
    {!inspectOnly ? <Button size="sm" disabled={blocked || accepted} onClick={accept}>
      {accepted ? 'Saved to your Batch' : `Accept ${suggestion.stage.replaceAll('-', ' ')} suggestion`}
    </Button> : null}
  </div>
}
