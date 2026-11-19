'use client'

import { useState } from 'react'
import Image from 'next/image'
import { PlateImageHover } from '@/components/plate/plate-image-preview'
import { CHECK_META } from '@/components/plate/status-icon'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import { Button } from '@/components/ui/button'
import type {
  ResearchDraft,
  ResearchResult as Result,
} from '@/lib/research/types'

type Field = 'description' | 'funFacts' | 'readMore' | 'wikiUrl'
const labels: Record<Field, string> = {
  description: 'Description',
  funFacts: 'Fun facts',
  readMore: 'Read-more links',
  wikiUrl: 'Wikipedia link',
}
const textClass =
  'w-full min-w-0 field-sizing-content resize-y rounded-lg bg-[var(--fill)] p-2 text-sm'
const fieldIcons = {
  description: CHECK_META.description.icon,
  funFacts: CHECK_META.funFacts.icon,
  readMore: CHECK_META.link.icon,
  wikiUrl: CHECK_META.link.icon,
}

/**
 * Show validated research and its evidence while allowing the curator to select what to
 * accept.
 */
export function ResearchResult({
  result,
  plate,
  pending,
  canEditDraft = false,
  onAccept,
}: {
  result: Result
  plate?: Pick<PlateCardData, 'displayName' | 'imageUrl'>
  pending: boolean
  canEditDraft?: boolean
  onAccept(fields: Field[], draft: ResearchDraft): void
}) {
  const [draft, setDraft] = useState(() => structuredClone(result.draft))
  const [selected, setSelected] = useState<Field[]>([])
  const available = {
    description: !!draft.description,
    funFacts: draft.funFacts.length > 0,
    readMore: draft.readMore.length > 0,
    wikiUrl: !!draft.wikiSource,
  }
  const fields = (Object.keys(labels) as Field[]).filter(
    (field) => available[field]
  )
  const sources = new Map(result.sources.map((source) => [source.id, source]))
  return (
    <div className="grid w-full min-w-0 max-w-lg gap-3 rounded-xl border border-[var(--hairline)] p-3">
      <header className="flex items-center gap-3">
        {plate?.imageUrl && (
          <PlateImageHover
            plateId={result.input.plateId}
            plateName={plate.displayName}
            before={plate.imageUrl}
          >
            <Image
              src={plate.imageUrl}
              alt={plate.displayName}
              width={160}
              height={80}
              unoptimized
              className="h-16 w-32 shrink-0 object-contain"
            />
          </PlateImageHover>
        )}
        <div className="min-w-0">
          <strong className="block text-sm">
            {plate?.displayName ?? result.input.displayName}
          </strong>
          <span className="caption">
            {fields.length
              ? `${fields.length} suggested ${fields.length === 1 ? 'change' : 'changes'}`
              : 'No changes found'}
          </span>
        </div>
      </header>
      <fieldset disabled={pending} className="grid min-w-0 gap-2">
        <legend className="sr-only">
          Choose fields to accept into this Batch
        </legend>
        {fields.map((field) => {
          const Icon = fieldIcons[field]
          return (
            <div
              key={field}
              className="grid min-w-0 gap-1 border-t border-[var(--hairline)] pt-2"
            >
              <label className="flex min-h-7 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(field)}
                  onChange={(event) =>
                    setSelected((previous) =>
                      event.target.checked
                        ? [...previous, field]
                        : previous.filter((item) => item !== field)
                    )
                  }
                />
                <Icon className="size-4" aria-hidden="true" />
                {labels[field]}
              </label>
              {field === 'description' && draft.description ? (
                <>
                  <textarea
                    aria-label="Edit description"
                    readOnly={!canEditDraft}
                    className={textClass}
                    rows={2}
                    value={draft.description}
                    onChange={(event) =>
                      setDraft((previous) => ({
                        ...previous,
                        description: event.target.value,
                      }))
                    }
                  />
                </>
              ) : null}
              {field === 'funFacts'
                ? draft.funFacts.map((fact, index) => (
                    <label key={index} className="grid gap-1">
                      <span className="sr-only">Fact {index + 1}</span>
                      <textarea
                        aria-label={`Edit fact ${index + 1}`}
                        readOnly={!canEditDraft}
                        className={textClass}
                        rows={1}
                        value={fact.text}
                        onChange={(event) =>
                          setDraft((previous) => ({
                            ...previous,
                            funFacts: previous.funFacts.map((item, at) =>
                              at === index
                                ? { ...item, text: event.target.value }
                                : item
                            ),
                          }))
                        }
                      />
                    </label>
                  ))
                : null}
              {field === 'readMore' && (
                <ul className="grid gap-1 pl-6 text-sm">
                  {draft.readMore.map((id) => (
                    <li key={id}>{sources.get(id)?.title ?? id}</li>
                  ))}
                </ul>
              )}
              {field === 'wikiUrl' && (
                <span className="pl-6 text-sm">
                  {sources.get(draft.wikiSource ?? '')?.title ??
                    draft.wikiSource}
                </span>
              )}
            </div>
          )
        })}
        <Button
          size="sm"
          className="justify-self-start"
          disabled={!selected.length || pending}
          onClick={() => onAccept(selected, draft)}
        >
          Accept selected fields
        </Button>
      </fieldset>
      {result.sources.length > 0 && (
        <details>
          <summary className="caption cursor-pointer">
            Sources ({result.sources.length})
          </summary>
          <div className="grid min-w-0 gap-2 pt-2">
            {result.sources.map((source) => (
              <div key={source.id} className="min-w-0">
                <a
                  className="break-words text-sm underline"
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {source.title}
                </a>
                <details>
                  <summary className="caption cursor-pointer">
                    Captured evidence
                  </summary>
                  <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm">
                    {source.text}
                  </p>
                </details>
              </div>
            ))}
          </div>
        </details>
      )}
      <details>
        <summary className="caption cursor-pointer">Run details</summary>
        <p className="caption pt-1">
          {result.provenance.servedByFallback ? 'Served by fallback · ' : ''}
          {result.provenance.model} · {result.status} ·{' '}
          {(result.durationMs / 1000).toFixed(1)}s ·{' '}
          {result.cost.usd === null
            ? 'Cost unavailable'
            : `$${result.cost.usd.toFixed(4)} known cost`}
        </p>
        {result.cost.missing > 0 && (
          <p className="caption">Some costs were unmeasured.</p>
        )}
        {result.rejected.length > 0 && (
          <ul className="caption">
            {result.rejected.map((item, index) => (
              <li key={index}>
                {item.field} · {item.reason}
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  )
}
