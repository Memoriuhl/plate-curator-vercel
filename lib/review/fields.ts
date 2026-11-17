import type { EditableFields } from './types'

export const limits = { tags: 50, tag: 60, text: 120, plates: 50 }
export const editableKeys = ['tags', 'templateFamily', 'templateRole', 'variantOfPlateId', 'isStandard', 'description', 'deleted'] as const
const keys = new Set<string>(editableKeys)

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
  const entries = Object.entries(input)
  if (entries.length === 0 || entries.some(([key]) => !keys.has(key))) return null

  const fields: EditableFields = {}
  for (const [key, value] of entries) {
    if (key === 'tags') {
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
