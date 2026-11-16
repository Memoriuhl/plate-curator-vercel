import { createHash } from 'node:crypto'
import type { Plate } from '../catalog/types'

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, sortedJsonValue(entry)]))
  }
  return value
}

export function plateRevision(plate: Plate): string {
  return createHash('sha256').update(JSON.stringify(sortedJsonValue(plate))).digest('hex').slice(0, 20)
}
