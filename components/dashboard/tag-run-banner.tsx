'use client'

import { useRef, useState } from 'react'
import { useBatch, useEditPlate } from '@/lib/client/hooks'
import { Button } from '@/components/ui/button'
import { editErrors, type RunEntry, type RunPlate } from './use-tag-run'

export function mergeTags(tags: string[], accepted: string[]) {
  return [
    ...new Set(
      [...tags, ...accepted]
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
}

export function TagRunBanner({
  entries,
  batchId,
  starting,
  dismiss,
  retry,
}: {
  entries: RunEntry[]
  batchId: string | null
  starting: boolean
  dismiss(): void
  retry(plate: RunPlate): void
}) {
  const detail = useBatch(batchId, { reuse: true })
  const { edit, pending } = useEditPlate()
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Record<string, string[]>>({})
  const saving = useRef(false)
  const counts = (state: string) =>
    entries.filter((entry) => !entry.error && entry.job.state === state).length
  const active = starting || counts('queued') + counts('claimed') > 0
  async function accept(plate: RunPlate, suggestions: string[]) {
    if (saving.current) return
    saving.current = true
    const currentTags =
      detail.data?.plates.find((entry) => entry.proposed.id === plate.id)
        ?.proposed.tags ??
      saved[plate.id] ??
      plate.tags
    const tags = mergeTags(currentTags, suggestions)
    try {
      const result = await edit(plate as Parameters<typeof edit>[0], { tags })
      setMessages((current) => ({
        ...current,
        [plate.id]: result.ok
          ? 'Saved to your batch'
          : editErrors[result.error],
      }))
      if (result.ok)
        setSaved((current) => ({
          ...current,
          [plate.id]: result.proposed.tags,
        }))
    } catch {
      setMessages((current) => ({
        ...current,
        [plate.id]: 'Could not save. Check your connection and try again.',
      }))
    } finally {
      saving.current = false
    }
  }
  if (!entries.length) return null
  return (
    <section className="col-span-full basis-full rounded-xl bg-[var(--card)] p-4 text-[var(--ink)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" aria-live="polite">
          Tagging {entries.length} plates · {counts('queued')} queued ·{' '}
          {counts('claimed')} claimed · {counts('completed')} done ·{' '}
          {counts('expired')} expired
          {entries.some((entry) => entry.error)
            ? ` · ${entries.filter((entry) => entry.error).length} failed`
            : ''}
        </p>
        {!active ? (
          <Button size="sm" variant="ghost" onClick={dismiss}>
            Dismiss
          </Button>
        ) : null}
      </div>
      <details open className="mt-3">
        <summary className="label cursor-pointer">Plate results</summary>
        {entries
          .filter(
            (entry) =>
              entry.error || ['completed', 'expired'].includes(entry.job.state),
          )
          .map((entry) => {
            const tags =
              detail.data?.plates.find(
                (item) => item.proposed.id === entry.plate.id,
              )?.proposed.tags ??
              saved[entry.plate.id] ??
              entry.plate.tags
            const suggestions = mergeTags([], entry.job.suggestions).filter(
              (tag) => !mergeTags(tags, []).includes(tag),
            )
            return (
              <div
                key={entry.plate.id}
                className="grid gap-2 border-t border-[var(--hairline)] py-3"
              >
                <strong>{entry.plate.displayName}</strong>
                <p className="caption">
                  Current tags: {tags.join(', ') || 'None'}
                </p>
                {entry.error ? <p role="alert">{entry.error}</p> : null}
                {entry.job.state === 'completed' && !entry.error ? (
                  <div className="flex flex-wrap gap-2">
                    {suggestions.map((tag) => (
                      <Button
                        key={tag}
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        aria-label={`Accept ${tag} for ${entry.plate.displayName}`}
                        onClick={() => void accept(entry.plate, [tag])}
                      >
                        {tag} +
                      </Button>
                    ))}
                    {suggestions.length ? (
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() => void accept(entry.plate, suggestions)}
                      >
                        Accept all
                      </Button>
                    ) : (
                      <p className="caption">No new suggestions.</p>
                    )}
                  </div>
                ) : null}
                {entry.job.state === 'expired' || entry.error ? (
                  <div className="flex items-center gap-2">
                    {entry.job.state === 'expired' ? (
                      <span>Timed out; try again</span>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={starting}
                      onClick={() => retry(entry.plate)}
                    >
                      Retry
                    </Button>
                  </div>
                ) : null}
                {messages[entry.plate.id] ? (
                  <p
                    role={
                      messages[entry.plate.id] === 'Saved to your batch'
                        ? 'status'
                        : 'alert'
                    }
                  >
                    {messages[entry.plate.id]}
                  </p>
                ) : null}
              </div>
            )
          })}
      </details>
    </section>
  )
}
