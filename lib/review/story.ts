import type { StoryFields } from '../catalog/types'
import { sortedJsonValue } from './canonical-value'

export const storyFieldKeys = ['funFacts', 'firstIssuedYear', 'wikiUrl', 'readMore'] as const

export function sameEditableValue(key: string, before: unknown, after: unknown) {
  const normalize = (value: unknown) => {
    if (key === 'funFacts' || key === 'readMore') return value ?? []
    if (['firstIssuedYear', 'sourceUrl', 'wikiUrl', 'colorDetail', 'lineageColor'].includes(key)) return value ?? null
    return value
  }
  return JSON.stringify(sortedJsonValue(normalize(before))) === JSON.stringify(sortedJsonValue(normalize(after)))
}

export function changedStoryFields(before: StoryFields, after: StoryFields): StoryFields {
  return Object.fromEntries(storyFieldKeys
    .filter(key => !sameEditableValue(key, before[key], after[key]))
    .map(key => [key, after[key]]))
}
