import type { EditableFields } from '../review/types'
import { parseEditableFields, storyUrl } from '../review/fields'
import type { FieldSuggestion, PipelineStage } from './types'
import { parseEnhancedImageSuggestion } from './image-enhancement'
import { parseGroupSuggestion, parseImageSuggestion } from './specialized-suggestions'

const stageFields: Record<PipelineStage, readonly (keyof EditableFields)[]> = {
  research: ['wikiUrl', 'description', 'funFacts', 'firstIssuedYear', 'readMore'],
  describe: ['description'],
  story: ['funFacts', 'firstIssuedYear', 'readMore'],
  'wiki-link': ['wikiUrl'],
  colors: ['colorDetail', 'lineageColor', 'tags'],
  'find-image': [],
  'enhance-image': [],
  group: [],
  order: [],
}

export function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === 'string' && Object.hasOwn(stageFields, value)
}

export function parseFieldSuggestion(input: unknown, expected: PipelineStage): FieldSuggestion | null {
  if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1' || !input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  if (expected === 'enhance-image') return parseEnhancedImageSuggestion(input)
  if (expected === 'find-image') return parseImageSuggestion(input)
  if (expected === 'group') return parseGroupSuggestion(input)
  if (value.kind !== 'fields' || value.stage !== expected || !isPipelineStage(value.stage) || Object.keys(value).some(key => !['kind', 'stage', 'fields', 'sources'].includes(key))) return null
  const fields = parseEditableFields(value.fields)
  if (!fields || Object.keys(fields).some(key => !stageFields[expected].includes(key as keyof EditableFields))) return null
  if (!Array.isArray(value.sources) || value.sources.length > 16) return null
  const sources = value.sources.map(storyUrl)
  if (sources.some(source => !source)) return null
  const normalizedSources = [...new Set(sources as string[])].sort()
  if (['research', 'describe', 'story', 'wiki-link'].includes(expected) && !normalizedSources.length) return null
  if (fields.funFacts?.some(fact => !normalizedSources.includes(fact.sourceUrl))) return null
  if (fields.firstIssuedYear != null && expected !== 'research' && !fields.funFacts?.some(fact => normalizedSources.includes(fact.sourceUrl))) return null
  if (fields.readMore?.some(link => !normalizedSources.includes(link.url))) return null
  if (fields.wikiUrl && !normalizedSources.includes(fields.wikiUrl)) return null
  return { kind: 'fields', stage: expected, fields: Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))), sources: normalizedSources }
}
