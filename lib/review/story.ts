import type { StoryFields } from '../catalog/types'
import { sortedJsonValue } from './canonical-value'

export const storyFieldKeys = [
  'funFacts',
  'firstIssuedYear',
  'wikiUrl',
  'readMore',
] as const

/**
 * Compare editable values using field-specific defaults and canonical object ordering.
 */
export function sameEditableValue(
  key: string,
  before: unknown,
  after: unknown
) {
  /** Treat a missing optional story value the same as its empty stored representation. */
  const normalize = (value: unknown) => {
    if (key === 'funFacts' || key === 'readMore') return value ?? []
    if (
      [
        'firstIssuedYear',
        'sourceUrl',
        'wikiUrl',
        'colorDetail',
        'lineageColor',
      ].includes(key)
    )
      return value ?? null
    return value
  }
  return (
    JSON.stringify(sortedJsonValue(normalize(before))) ===
    JSON.stringify(sortedJsonValue(normalize(after)))
  )
}

export function changedDraftField(
  field: string,
  before: unknown,
  after: unknown
) {
  return field === 'isStandard' || field === 'deleted'
    ? Boolean(before) !== Boolean(after)
    : !sameEditableValue(field, before, after)
}

/** Extract just the story fields whose editable values changed. */
export function changedStoryFields(
  before: StoryFields,
  after: StoryFields
): StoryFields {
  return Object.fromEntries(
    storyFieldKeys
      .filter((key) => !sameEditableValue(key, before[key], after[key]))
      .map((key) => [key, after[key]])
  )
}
