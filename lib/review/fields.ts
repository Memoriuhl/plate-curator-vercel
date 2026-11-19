import type { EditableFields } from './types'
import { storyFieldKeys } from './story'
import { commonsImageUrl, commonsSourceUrl } from '../jobs/image-options'

export const limits = { tags: 50, tag: 60, text: 120, plates: 1000 }
/**
 * The shared draft collects every unpublished change until the next Publish, so it gets
 * a larger plate cap than one request or an old Batch.
 */
export const draftPlateLimit = 10_000
/** Plate cap for the ids a batch may track. */
export function batchPlateLimit(batch: { kind?: string }) {
  return batch.kind === 'shared-draft' ? draftPlateLimit : limits.plates
}
const storyKeys = storyFieldKeys
export const colorFieldKeys = ['colorDetail', 'lineageColor'] as const
export const draftGroupingFields = [
  'templateFamily',
  'templateRole',
  'variantOfPlateId',
] as const
const imageKeys = ['imageUrl', 'sourceUrl'] as const
export const editableKeys = [
  'tags',
  'templateFamily',
  'templateRole',
  'variantOfPlateId',
  'isStandard',
  'description',
  'deleted',
  ...storyKeys,
  ...imageKeys,
  ...colorFieldKeys,
] as const
/** List the editable plate fields enabled by the current local pipeline configuration. */
export function editableFieldKeys() {
  return editableKeys.filter(
    (key) =>
      process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' ||
      ![...storyKeys, ...imageKeys, ...colorFieldKeys].some(
        (localKey) => localKey === key
      )
  )
}

/**
 * Normalize a bounded URL for story evidence while accepting only supported protocols.
 */
export function storyUrl(value: unknown): string | null {
  const text = boundedText(value, 2048)
  if (!text) return null
  try {
    const url = new URL(text)
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? text
      : null
  } catch {
    return null
  }
}

/** Narrow an incoming field payload to an object so its keys can be validated. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Trim a user-entered string and enforce the storage bound for the field. */
function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length > 0 && text.length <= max ? text : null
}

/**
 * Normalize the recognized field values and reject changes outside the supplied
 * allowlist.
 */
function parseFields(
  input: unknown,
  keys: ReadonlySet<string>
): EditableFields | null {
  if (!isRecord(input)) return null
  const entries = Object.entries(input)
  if (entries.length === 0 || entries.some(([key]) => !keys.has(key)))
    return null

  const fields: EditableFields = {}
  for (const [key, value] of entries) {
    if (key === 'colorDetail' || key === 'lineageColor') {
      const text = boundedText(value, key === 'colorDetail' ? 120 : 60)
      if (value !== null && !text) return null
      fields[key] = text
    } else if (key === 'imageUrl') {
      const url = commonsImageUrl(value)
      if (value !== null && !url) return null
      fields.imageUrl = url
    } else if (key === 'firstIssuedYear') {
      if (
        value !== null &&
        (typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < 1800 ||
          value > 2100)
      )
        return null
      fields.firstIssuedYear = value as number | null
    } else if (key === 'wikiUrl' || key === 'sourceUrl') {
      const url = storyUrl(value)
      if (value !== null && !url) return null
      fields[key] = url
    } else if (key === 'funFacts') {
      if (!Array.isArray(value) || value.length > 4) return null
      const facts = []
      for (const fact of value) {
        if (
          !isRecord(fact) ||
          Object.keys(fact).some(
            (key) => !['text', 'sourceUrl', 'sourceTitle'].includes(key)
          )
        )
          return null
        const text = boundedText(fact.text, 500)
        const sourceUrl = storyUrl(fact.sourceUrl)
        const sourceTitle =
          fact.sourceTitle === undefined
            ? undefined
            : boundedText(fact.sourceTitle, 300)
        if (!text || !sourceUrl || sourceTitle === null) return null
        facts.push({ text, sourceUrl, ...(sourceTitle ? { sourceTitle } : {}) })
      }
      fields.funFacts = facts
    } else if (key === 'readMore') {
      if (!Array.isArray(value) || value.length > 8) return null
      const links = []
      for (const link of value) {
        if (
          !isRecord(link) ||
          Object.keys(link).some(
            (key) => !['title', 'site', 'url'].includes(key)
          )
        )
          return null
        const title = boundedText(link.title, 200)
        const site = boundedText(link.site, 200)
        const url = storyUrl(link.url)
        if (!title || site === null || !url) return null
        links.push({ title, site, url })
      }
      fields.readMore = links
    } else if (key === 'tags') {
      if (!Array.isArray(value) || value.length > limits.tags) return null
      const tags = value.map((tag) => boundedText(tag, limits.tag))
      if (tags.some((tag) => tag === null)) return null
      fields.tags = tags as string[]
    } else if (key === 'description') {
      const text = boundedText(value, 2000)
      if (value !== null && text === null) return null
      fields.description = text
    } else if (key === 'variantOfPlateId' && value === null) {
      fields.variantOfPlateId = null
    } else if (key === 'templateRole') {
      if (value !== 'template' && value !== 'variant') return null
      fields.templateRole = value
    } else if (key === 'isStandard' || key === 'deleted') {
      if (typeof value !== 'boolean') return null
      fields[key] = value
    } else {
      const text = boundedText(value, limits.text)
      if (text === null) return null
      fields[key as 'templateFamily' | 'variantOfPlateId'] = text
    }
  }
  return fields
}

/**
 * Validate curator-editable fields and keep an image URL paired with its Commons source.
 */
export function parseEditableFields(
  input: unknown,
  candidate?: { imageUrl: string; sourceUrl: string }
): EditableFields | null {
  if (
    isRecord(input) &&
    (Object.hasOwn(input, 'sourceUrl') || Object.hasOwn(input, 'imageUrl'))
  ) {
    if (!Object.hasOwn(input, 'sourceUrl') || !Object.hasOwn(input, 'imageUrl'))
      return null
    if (
      input.imageUrl === null
        ? input.sourceUrl !== null
        : !candidate ||
          input.imageUrl !== candidate.imageUrl ||
          input.sourceUrl !== candidate.sourceUrl ||
          !commonsSourceUrl(input.sourceUrl)
    )
      return null
  }
  return parseFields(input, new Set(editableFieldKeys()))
}

/** Validate only the story fields accepted by enrichment and manual story editing. */
export function parseStoryFields(input: unknown): EditableFields | null {
  return parseFields(input, new Set(storyKeys))
}

/** Validate only the color fields supported by the local pipeline. */
export function parseColorFields(input: unknown): EditableFields | null {
  return parseFields(input, new Set(colorFieldKeys))
}

/** Parse the requested title and plate IDs before creating a review batch. */
export function parseBatchInput(
  input: unknown
): { name: string; plateIds: string[] } | null {
  if (!isRecord(input)) return null
  const name = boundedText(input.name, limits.text)
  const plateIds = input.plateIds
  if (
    name === null ||
    !Array.isArray(plateIds) ||
    plateIds.length === 0 ||
    plateIds.length > limits.plates
  )
    return null
  if (!plateIds.every((id) => boundedText(id, limits.text) === id)) return null
  return { name, plateIds: plateIds as string[] }
}
