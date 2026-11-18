import { createHash } from 'node:crypto'
import type { Plate } from '../catalog/types'
import { sortedJsonValue } from './canonical-value'

export function plateRevision(plate: Plate): string {
  return createHash('sha256').update(JSON.stringify(sortedJsonValue(plate))).digest('hex').slice(0, 20)
}
