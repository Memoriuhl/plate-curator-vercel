import type { Plate } from '../catalog/types'
import type { EditableFields } from '../review/types'

export const enrichmentFields = ['wikiUrl', 'description', 'funFacts', 'readMore', 'firstIssuedYear'] as const
export type EnrichmentField = typeof enrichmentFields[number]
export type EnrichmentPolicy = 'fill-missing' | 'replace'
export type EnrichmentOptions = { policy?: EnrichmentPolicy; reuseSavedSources?: boolean }
export const savedResearchSourcesHeader = 'x-plate-curator-reuse-saved-sources'

export function shouldReuseSavedSources(options?: EnrichmentOptions) {
  return options?.reuseSavedSources === true && options.policy !== 'replace'
}

export function hasEnrichmentValue(value: unknown): boolean {
  return value !== null && value !== undefined && (typeof value !== 'string' || !!value.trim()) && (!Array.isArray(value) || value.length > 0)
}

export function enrichmentTargets(plate: Partial<Plate>, policy: EnrichmentPolicy): EnrichmentField[] {
  return enrichmentFields.filter(field => policy === 'replace' || !hasEnrichmentValue(plate[field]))
}

// Never project a null/empty model result onto saved content, even in Replace.
export function filterEnrichmentFields(fields: Partial<EditableFields>, plate: Partial<Plate>, policy: EnrichmentPolicy): Partial<EditableFields> {
  const targets = enrichmentTargets(plate, policy)
  return Object.fromEntries(Object.entries(fields).filter(([field, value]) => targets.includes(field as EnrichmentField) && hasEnrichmentValue(value)))
}
