'use client'

import { useId, useState } from 'react'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import type { Plate } from '@/lib/catalog/types'
import type {
  GroupSuggestion,
  ImageSuggestion,
} from '@/lib/jobs/specialized-suggestions'

export type SpecializedAccept =
  { candidateId: string; baseRevision: string } | { batchRevision: number }

/**
 * Present a grouping or image result and collect any choice required before applying it.
 */
export function SpecializedSuggestion({
  suggestion,
  plates,
  baseRevision,
  batchRevision,
  blocked,
  accepted,
  selectedCandidateId,
  onSelectImage,
  accept,
  previewOnly,
}: {
  suggestion: ImageSuggestion | GroupSuggestion
  plates: Plate[]
  baseRevision?: string
  batchRevision?: number
  blocked: boolean
  accepted: boolean
  selectedCandidateId?: string
  previewOnly?: boolean
  onSelectImage?(candidateId: string): Promise<void>
  accept?(payload: SpecializedAccept): Promise<void>
}) {
  const [candidateId, setCandidateId] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const radioName = useId()
  const currentChoice = candidateId ?? selectedCandidateId
  /**
   * Apply the selected specialized suggestion while guarding duplicate saves and
   * reporting errors.
   */
  async function apply() {
    if (blocked || accepted || saving) return
    const payload =
      suggestion.kind === 'image'
        ? currentChoice && baseRevision
          ? { candidateId: currentChoice, baseRevision }
          : null
        : batchRevision !== undefined
          ? { batchRevision }
          : null
    if (suggestion.kind === 'image' && onSelectImage && currentChoice) {
      setSaving(true)
      setError(undefined)
      try {
        await onSelectImage(currentChoice)
      } catch {
        setError('Could not save the image choice. Try again.')
      } finally {
        setSaving(false)
      }
      return
    }
    if (!payload || !accept) return
    setSaving(true)
    setError(undefined)
    try {
      await accept(payload)
    } catch {
      setError(
        'Could not apply this result. Reload the Batch and check whether the result is still current.'
      )
    } finally {
      setSaving(false)
    }
  }
  const candidate =
    suggestion.kind === 'image'
      ? suggestion.candidates.find((value) => value.id === currentChoice)
      : undefined
  const groups =
    suggestion.kind === 'group'
      ? Map.groupBy(
          suggestion.proposals,
          (value) => value.fields.templateFamily
        )
      : null
  return (
    <section
      aria-label={
        suggestion.kind === 'image' ? 'Image candidates' : 'Group proposal'
      }
      className="grid gap-[var(--stack-gap)]"
    >
      {suggestion.kind === 'image' ? (
        <>
          <p className="caption">
            {previewOnly
              ? 'Choose a photo to inspect in this Preview run. These results cannot be applied.'
              : onSelectImage
                ? 'Choose a photo for this run. Your Batch changes only when you apply the run.'
                : 'Choose a photo to review in your Batch.'}{' '}
            Upload is required before publishing.
          </p>
          <fieldset
            disabled={blocked || accepted || saving}
            className="grid gap-[var(--stack-gap)]"
          >
            <legend className="label">Image candidates</legend>
            {suggestion.candidates.map((value) => (
              <div
                key={value.id}
                className="grid gap-2 rounded-[var(--radius-md)] bg-[var(--fill)] p-3"
              >
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={radioName}
                    checked={currentChoice === value.id}
                    onChange={() => setCandidateId(value.id)}
                  />
                  {value.title}
                </label>
                <Image
                  src={value.imageUrl}
                  width={value.width}
                  height={value.height}
                  alt={value.title}
                  unoptimized
                  className="h-auto max-h-48 w-auto max-w-full object-contain"
                />
                <p className="caption">
                  {value.width} × {value.height}
                  {value.license ? ` · ${value.license}` : ''}
                  {value.author ? ` · ${value.author}` : ''}
                </p>
                <a
                  href={value.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="caption break-all underline"
                >
                  Image provenance: {value.sourceUrl}
                </a>
              </div>
            ))}
          </fieldset>
        </>
      ) : (
        <>
          <p className="caption">
            {suggestion.scope.length} plates in {groups!.size} proposed{' '}
            {groups!.size === 1 ? 'family' : 'families'}.{' '}
            {previewOnly
              ? 'Preview results cannot be applied.'
              : 'All changes apply together.'}{' '}
            State order and Standard stay in place.
          </p>
          {[...groups!].map(([family, members]) => (
            <div
              key={family}
              className="grid gap-2 rounded-[var(--radius-md)] bg-[var(--fill)] p-3"
            >
              <strong>
                {plates.find(
                  (plate) =>
                    plate.id ===
                    members.find(
                      (member) => member.fields.templateRole === 'template'
                    )?.plateId
                )?.displayName ?? family}
              </strong>
              <ul className="grid gap-2">
                {members.map((member) => {
                  const plate = plates.find(
                    (plate) => plate.id === member.plateId
                  )
                  return (
                    <li key={member.plateId}>
                      <span>{plate?.displayName ?? member.plateId}</span>
                      <p className="caption">
                        {plate?.templateFamily ?? 'No family'} → {family} ·{' '}
                        {member.fields.templateRole === 'template'
                          ? 'Template'
                          : 'Variant'}
                      </p>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </>
      )}
      {accept || (onSelectImage && suggestion.kind === 'image') ? (
        <Button
          size="sm"
          disabled={
            blocked ||
            accepted ||
            saving ||
            (suggestion.kind === 'image'
              ? !candidate || (!onSelectImage && !baseRevision)
              : batchRevision === undefined)
          }
          onClick={() => void apply()}
        >
          {accepted
            ? onSelectImage
              ? 'Selected for this run'
              : 'Saved to your Batch'
            : saving
              ? 'Saving…'
              : suggestion.kind === 'image'
                ? onSelectImage
                  ? 'Use selected image for this run'
                  : 'Apply selected image to your Batch'
                : 'Apply group to your Batch'}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="caption">
          {error}
        </p>
      ) : null}
    </section>
  )
}
