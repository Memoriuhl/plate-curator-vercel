import type { Plate } from '../catalog/types'
import type { EditableFields } from '../review/types'

export const enrichmentFields = [
  'wikiUrl',
  'description',
  'funFacts',
  'readMore',
  'firstIssuedYear',
] as const
export type EnrichmentField = (typeof enrichmentFields)[number]
export type EnrichmentPolicy = 'fill-missing' | 'replace'
export type EnrichmentOptions = {
  policy?: EnrichmentPolicy
  reuseSavedSources?: boolean
}
export const savedResearchSourcesHeader = 'x-plate-curator-reuse-saved-sources'

/**
 * Why research did not write a field. Saved on the job result so the run panel can
 * explain a step that finished without changing the plate.
 */
export const researchNoteReasons = [
  'already_filled',
  'not_found',
  'unsupported_claim',
  'length',
  'source_not_fetched',
  'invalid_draft',
] as const
export type ResearchNote = {
  field: EnrichmentField
  reason: (typeof researchNoteReasons)[number]
}

/** Accept only well-formed research notes from a worker report. */
export function parseResearchNotes(value: unknown): ResearchNote[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 12) return null
  const notes: ResearchNote[] = []
  for (const note of value) {
    if (
      !note ||
      typeof note !== 'object' ||
      Object.keys(note).some((key) => key !== 'field' && key !== 'reason') ||
      !(enrichmentFields as readonly unknown[]).includes(note.field) ||
      !(researchNoteReasons as readonly unknown[]).includes(note.reason)
    )
      return null
    notes.push({ field: note.field, reason: note.reason })
  }
  return notes
}

export function shouldReuseSavedSources(options?: EnrichmentOptions) {
  return options?.reuseSavedSources === true && options.policy !== 'replace'
}

/** Treat absent and empty field values as needing enrichment. */
export function hasEnrichmentValue(value: unknown): boolean {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value !== 'string' || !!value.trim()) &&
    (!Array.isArray(value) || value.length > 0)
  )
}

/** Select the plate fields eligible for research under the run's overwrite policy. */
export function enrichmentTargets(
  plate: Partial<Plate>,
  policy: EnrichmentPolicy
): EnrichmentField[] {
  return enrichmentFields.filter(
    (field) => policy === 'replace' || !hasEnrichmentValue(plate[field])
  )
}

// Never project a null/empty model result onto saved content, even in Replace.
/**
 * Keep only eligible, populated research fields before turning the draft into a
 * suggestion.
 */
export function filterEnrichmentFields(
  fields: Partial<EditableFields>,
  plate: Partial<Plate>,
  policy: EnrichmentPolicy
): Partial<EditableFields> {
  const targets = enrichmentTargets(plate, policy)
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([field, value]) =>
        targets.includes(field as EnrichmentField) && hasEnrichmentValue(value)
    )
  )
}
