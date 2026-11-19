'use client'

import { useRef, useState } from 'react'
import { useBatch, useEditPlate, useWorkspaceBatch } from '@/lib/client/hooks'
import { Button } from '@/components/ui/button'
import { editErrors, type RunEntry, type RunPlate } from './use-tag-run'
import { parseFieldSuggestion } from '@/lib/jobs/suggestions'
import type { FieldSuggestion as Suggestion } from '@/lib/jobs/types'
import { FieldSuggestion } from './field-suggestion'
import {
  SpecializedSuggestion,
  type SpecializedAccept,
} from './specialized-suggestion'
import { useSession } from '@/lib/client/session'
import { useSWRConfig } from 'swr'

/**
 * Merge saved and proposed tags into a normalized, deduplicated list for curator review.
 */
export function mergeTags(tags: string[], accepted: string[]) {
  return [
    ...new Set(
      [...tags, ...accepted]
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
    ),
  ]
}

/**
 * Summarize individual job outcomes and let the curator apply available tagging and
 * pipeline results.
 */
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
  const workspace = useWorkspaceBatch()
  const blocked =
    workspace.mode === 'selected' &&
    (workspace.status !== 'ready' ||
      workspace.id !== batchId ||
      workspace.detail?.batch.state !== 'open')
  const detail = useBatch(batchId, { reuse: true })
  const { api } = useSession()
  const { mutate } = useSWRConfig()
  const { edit, pending } = useEditPlate()
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Record<string, string[]>>({})
  const [savedFields, setSavedFields] = useState<Record<string, string>>({})
  const saving = useRef(false)
  /** Count results that are still progressing or completed without a stage error. */
  const counts = (state: string) =>
    entries.filter(
      (entry) =>
        !entry.error &&
        entry.job.state === state &&
        (state !== 'completed' || !entry.job.stageError)
    ).length
  const active = starting || counts('queued') + counts('claimed') > 0
  /**
   * Apply a specialized stage result through its endpoint and refresh the saved batch.
   */
  async function acceptSpecialized(
    entry: RunEntry,
    payload: SpecializedAccept
  ) {
    if (entry.job.previewOnly || blocked || !batchId || !entry.jobId)
      throw new Error('Result is unavailable')
    const endpoint = 'candidateId' in payload ? 'images' : 'group'
    await api.send('POST', `/api/batches/${batchId}/${endpoint}/accept`, {
      ...payload,
      jobId: entry.jobId,
    })
    setSavedFields((current) => ({
      ...current,
      [entry.plate.id]: entry.jobId!,
    }))
    await mutate(`/api/batches/${batchId}`)
  }
  /**
   * Save ordinary field suggestions into the draft and track the fields already
   * accepted.
   */
  async function acceptFields(entry: RunEntry, suggestion: Suggestion) {
    if (entry.job.previewOnly || suggestion.kind !== 'fields') return
    if (saving.current || blocked || !batchId || !entry.job.inputHash) return
    saving.current = true
    try {
      const result = await edit(
        entry.plate as Parameters<typeof edit>[0],
        suggestion.fields,
        { batchId, baseRevision: entry.job.inputHash }
      )
      setMessages((current) => ({
        ...current,
        [entry.plate.id]: result.ok
          ? 'Saved to your batch'
          : editErrors[result.error],
      }))
      if (result.ok)
        setSavedFields((current) => ({
          ...current,
          [entry.plate.id]: entry.jobId ?? entry.job.inputHash!,
        }))
    } catch {
      setMessages((current) => ({
        ...current,
        [entry.plate.id]:
          'Could not save. Check your connection and try again.',
      }))
    } finally {
      saving.current = false
    }
  }
  /** Save the selected tag suggestions and keep the run's per-plate status up to date. */
  async function accept(
    plate: RunPlate,
    suggestions: string[],
    revision: string
  ) {
    if (saving.current || blocked || !batchId) return
    saving.current = true
    const currentTags =
      detail.data?.plates.find((entry) => entry.proposed.id === plate.id)
        ?.proposed.tags ??
      saved[plate.id] ??
      plate.tags
    const tags = mergeTags(currentTags, suggestions)
    try {
      const result = await edit(
        plate as Parameters<typeof edit>[0],
        { tags },
        { batchId, baseRevision: revision }
      )
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
          {entries.some((entry) => entry.job.stage)
            ? 'Running pipeline on'
            : 'Tagging'}{' '}
          {entries.length} plates · {counts('queued')} queued ·{' '}
          {counts('claimed')} claimed ·{' '}
          {
            entries.filter(
              (entry) =>
                entry.job.state === 'completed' && !entry.job.stageError
            ).length
          }{' '}
          done · {counts('expired')} expired
          {entries.some(
            (entry) => entry.job.state === 'completed' && entry.job.stageError
          )
            ? ` · ${entries.filter((entry) => entry.job.state === 'completed' && entry.job.stageError).length} no result`
            : ''}
          {counts('failed') ? ` · ${counts('failed')} failed` : ''}
          {counts('cancelled') ? ` · ${counts('cancelled')} cancelled` : ''}
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
              entry.error ||
              ['completed', 'expired', 'failed', 'cancelled'].includes(
                entry.job.state
              )
          )
          .map((entry) => {
            const fieldSuggestion = entry.job.stage
              ? parseFieldSuggestion(entry.job.fieldSuggestion, entry.job.stage)
              : null
            const tags =
              detail.data?.plates.find(
                (item) => item.proposed.id === entry.plate.id
              )?.proposed.tags ??
              saved[entry.plate.id] ??
              entry.plate.tags
            const suggestions = mergeTags([], entry.job.suggestions).filter(
              (tag) => !mergeTags(tags, []).includes(tag)
            )
            return (
              <div
                key={entry.plate.id}
                className="grid gap-2 border-t border-[var(--hairline)] py-3"
              >
                <strong>{entry.plate.displayName}</strong>
                {!entry.job.stage ? (
                  <p className="caption">
                    Current tags: {tags.join(', ') || 'None'}
                  </p>
                ) : null}
                {entry.error ? <p role="alert">{entry.error}</p> : null}
                {entry.job.previewOnly ? (
                  <p className="caption">
                    Preview result · inspect only. Rerun normally to apply.
                  </p>
                ) : null}
                {entry.job.state === 'completed' &&
                !entry.error &&
                fieldSuggestion?.kind === 'fields' ? (
                  <FieldSuggestion
                    suggestion={fieldSuggestion}
                    before={
                      detail.data?.plates.find(
                        (item) => item.proposed.id === entry.plate.id
                      )?.proposed
                    }
                    blocked={pending || blocked || !entry.job.inputHash}
                    accepted={
                      !!entry.job.inputHash &&
                      savedFields[entry.plate.id] ===
                        (entry.jobId ?? entry.job.inputHash)
                    }
                    inspectOnly={entry.job.previewOnly}
                    accept={() => void acceptFields(entry, fieldSuggestion)}
                  />
                ) : null}
                {entry.job.state === 'completed' &&
                !entry.error &&
                (fieldSuggestion?.kind === 'image' ||
                  fieldSuggestion?.kind === 'group') ? (
                  <SpecializedSuggestion
                    suggestion={fieldSuggestion}
                    plates={
                      detail.data?.plates.map((item) => item.proposed) ?? []
                    }
                    baseRevision={entry.job.inputHash}
                    batchRevision={detail.data?.batch.revision}
                    blocked={pending || blocked || !entry.jobId}
                    accepted={
                      !!entry.jobId &&
                      savedFields[entry.plate.id] === entry.jobId
                    }
                    accept={
                      entry.job.previewOnly
                        ? undefined
                        : (payload) => acceptSpecialized(entry, payload)
                    }
                  />
                ) : null}
                {entry.job.state === 'completed' &&
                entry.job.stage &&
                !fieldSuggestion ? (
                  <p role="alert">
                    {entry.job.stageError === 'no_sources'
                      ? 'No usable Wikipedia source was found for this plate.'
                      : entry.job.stageError === 'missing_image'
                        ? 'The local plate image could not be read.'
                        : entry.job.stageError === 'no_supported_fields'
                          ? 'The sources do not support a suggestion for this plate.'
                          : 'This stage result is unavailable or invalid.'}
                  </p>
                ) : null}
                {entry.job.previewOnly && !entry.job.stage ? (
                  <p className="caption">
                    Suggested tags: {entry.job.suggestions.join(', ') || 'None'}
                  </p>
                ) : null}
                {entry.job.state === 'completed' &&
                !entry.error &&
                !entry.job.stage &&
                !entry.job.previewOnly ? (
                  <div className="flex flex-wrap gap-2">
                    {suggestions.map((tag) => (
                      <Button
                        key={tag}
                        size="sm"
                        variant="outline"
                        disabled={pending || blocked}
                        aria-label={`Accept ${tag} for ${entry.plate.displayName}`}
                        onClick={() =>
                          void accept(
                            entry.plate,
                            [tag],
                            entry.job.inputHash ?? entry.plate.revision
                          )
                        }
                      >
                        {tag} +
                      </Button>
                    ))}
                    {suggestions.length ? (
                      <Button
                        size="sm"
                        disabled={pending || blocked}
                        onClick={() =>
                          void accept(
                            entry.plate,
                            suggestions,
                            entry.job.inputHash ?? entry.plate.revision
                          )
                        }
                      >
                        Accept all
                      </Button>
                    ) : (
                      <p className="caption">No new suggestions.</p>
                    )}
                  </div>
                ) : null}
                {entry.job.servedByFallback ? (
                  <p className="caption">
                    Served by fallback · {entry.job.model}
                  </p>
                ) : null}
                {entry.job.state === 'failed' ? (
                  <p role="alert">
                    {entry.job.failure === 'strict_model_failed'
                      ? 'The selected model failed in Strict mode.'
                      : 'This stage failed. Later stages did not run.'}
                  </p>
                ) : null}
                {entry.job.state === 'cancelled' ? (
                  <p role="status">Cancelled after the active stage ended.</p>
                ) : null}
                {entry.job.state === 'expired' ||
                entry.job.state === 'failed' ||
                entry.error ||
                entry.job.stageError ? (
                  <div className="flex items-center gap-2">
                    {entry.job.state === 'expired' ? (
                      <span>Timed out; try again</span>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={starting || blocked}
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
