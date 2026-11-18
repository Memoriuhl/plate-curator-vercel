'use client'

const labels: Record<string, string> = {
  description: 'Description', funFacts: 'Fun facts', firstIssuedYear: 'First issued', readMore: 'Read more', wikiUrl: 'Reference page',
  imageUrl: 'Image', sourceUrl: 'Image provenance', templateFamily: 'Template family', templateRole: 'Family role', variantOfPlateId: 'Variant of', tags: 'Tags',
}

/** Resolve a friendly label for a pipeline field, humanizing unfamiliar names. */
export function pipelineFieldLabel(field: string) {
  return labels[field] ?? field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, value => value.toUpperCase())
}

/** Accept an HTTP or HTTPS value as a clickable pipeline result link. */
function href(value: unknown) {
  if (typeof value !== 'string') return undefined
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}

/**
 * Render a field diff value according to its shape, including citations and structured
 * values.
 */
export function PipelineFieldValue({ field, value, plateNames = {} }: { field: string; value: unknown; plateNames?: Record<string, string> }) {
  if (value === undefined || value === null || value === '' || Array.isArray(value) && !value.length) return <p className="caption">None</p>
  if (field === 'funFacts' && Array.isArray(value)) return <ul className="grid list-disc gap-2 pl-5">{value.map((raw, index) => {
    const fact = raw && typeof raw === 'object' ? raw as { text?: string; sourceUrl?: string; sourceTitle?: string } : { text: String(raw) }
    const source = href(fact.sourceUrl)
    return <li key={index}><p>{fact.text}</p>{source ? <a className="caption underline" href={source} target="_blank" rel="noreferrer">{fact.sourceTitle || 'Source'}</a> : null}</li>
  })}</ul>
  if (field === 'readMore' && Array.isArray(value)) return <ul className="grid gap-2">{value.map((raw, index) => {
    const link = raw && typeof raw === 'object' ? raw as { title?: string; site?: string; url?: string } : { title: String(raw) }
    const source = href(link.url)
    return <li key={index}>{source ? <a className="underline" href={source} target="_blank" rel="noreferrer">{link.title || 'Read more'}</a> : <span>{link.title}</span>}{link.site ? <p className="caption">{link.site}</p> : null}</li>
  })}</ul>
  if (['wikiUrl', 'imageUrl', 'sourceUrl'].includes(field) && href(value)) return <a className="break-words underline" href={href(value)} target="_blank" rel="noreferrer">View {pipelineFieldLabel(field).toLowerCase()}</a>
  if (Array.isArray(value)) return <ul className="flex flex-wrap gap-2">{value.map((entry, index) => <li key={index}><PipelineFieldValue field="value" value={entry} plateNames={plateNames} /></li>)}</ul>
  if (typeof value === 'object') return <dl className="grid gap-2">{Object.entries(value).map(([key, entry]) => <div key={key}><dt className="caption">{pipelineFieldLabel(key)}</dt><dd><PipelineFieldValue field={key} value={entry} plateNames={plateNames} /></dd></div>)}</dl>
  return <p className="whitespace-pre-wrap break-words">{typeof value === 'string' ? plateNames[value] ?? value : String(value)}</p>
}
