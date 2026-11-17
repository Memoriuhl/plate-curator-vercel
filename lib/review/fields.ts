import type { EditableFields } from './types'

export const limits = { tags: 50, tag: 60, text: 120, plates: 50 }
const baseKeys = ['tags', 'templateFamily', 'templateRole', 'variantOfPlateId', 'isStandard', 'description', 'deleted'] as const
const storyKeys = ['funFacts', 'firstIssuedYear', 'sourceUrl', 'wikiUrl', 'readMore'] as const
export const persistedEditableKeys = [...baseKeys, ...storyKeys]
export const editableKeys = persistedEditableKeys
export function editableFieldKeys() {
  return process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' ? [...baseKeys, ...storyKeys] : [...baseKeys]
}

export function storyUrl(value: unknown): string | null {
  const text = boundedText(value, 2048)
  if (!text) return null
  try {
    const url = new URL(text)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? text : null
  } catch { return null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length > 0 && text.length <= max ? text : null
}

export function parseEditableFields(input: unknown): EditableFields | null {
  if (!isRecord(input)) return null
  const keys = new Set<string>(editableFieldKeys())
  const entries = Object.entries(input)
  if (entries.length === 0 || entries.some(([key]) => !keys.has(key))) return null

  const fields: EditableFields = {}
  for (const [key, value] of entries) {
    if (key === 'firstIssuedYear') {
      if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 1800 || value > 2100)) return null
      fields.firstIssuedYear = value as number | null
    } else if (key === 'sourceUrl' || key === 'wikiUrl') {
      const url = storyUrl(value)
      if (value !== null && !url) return null
      fields[key] = url
    } else if (key === 'funFacts') {
      if (!Array.isArray(value) || value.length > 4) return null
      const facts = []
      for (const fact of value) {
        if (!isRecord(fact) || Object.keys(fact).some(key => !['text', 'sourceUrl', 'sourceTitle'].includes(key))) return null
        const text = boundedText(fact.text, 500)
        const sourceUrl = storyUrl(fact.sourceUrl)
        const sourceTitle = fact.sourceTitle === undefined ? undefined : boundedText(fact.sourceTitle, 200)
        if (!text || !sourceUrl || sourceTitle === null) return null
        facts.push({ text, sourceUrl, ...(sourceTitle ? { sourceTitle } : {}) })
      }
      fields.funFacts = facts
    } else if (key === 'readMore') {
      if (!Array.isArray(value) || value.length > 8) return null
      const links = []
      for (const link of value) {
        if (!isRecord(link) || Object.keys(link).some(key => !['title', 'site', 'url'].includes(key))) return null
        const title = boundedText(link.title, 200)
        const site = typeof link.site === 'string' && link.site.trim().length <= 200 ? link.site.trim() : null
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

export function parseBatchInput(input: unknown): { name: string; plateIds: string[] } | null {
  if (!isRecord(input)) return null
  const name = boundedText(input.name, limits.text)
  const plateIds = input.plateIds
  if (name === null || !Array.isArray(plateIds) || plateIds.length === 0 || plateIds.length > limits.plates) return null
  if (!plateIds.every((id) => boundedText(id, limits.text) === id)) return null
  return { name, plateIds: plateIds as string[] }
}
