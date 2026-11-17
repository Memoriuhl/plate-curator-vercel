import { validTarget } from './allocation'
import type { Snapshot } from '../catalog/types'

const groupingFields = ['templateFamily', 'templateRole', 'variantOfPlateId'] as const

export function validateSnapshot(baseline: Snapshot, candidate: unknown, deleted: ReadonlySet<string> = new Set()): string[] {
  if (!candidate || typeof candidate !== 'object' || !('plates' in candidate) || !Array.isArray(candidate.plates)) {
    return ['Snapshot must contain a plates array']
  }
  const reasons: string[] = []
  if (!('version' in candidate) || typeof candidate.version !== 'number' || !validTarget(baseline.version, candidate.version)) reasons.push('Snapshot version must be a greater safe integer')
  const ids = new Set<string>()
  const standards = new Map<string, number>()
  const families = new Map<string, number>()
  const baselinePlates = new Map(baseline.plates.map(plate => [plate.id, plate]))
  const baselineTemplateCounts = new Map<string, number>()
  const touchedFamilies = new Set<string>()
  for (const plate of baseline.plates) {
    if (typeof plate.templateFamily === 'string' && plate.templateRole === 'template') {
      baselineTemplateCounts.set(plate.templateFamily, (baselineTemplateCounts.get(plate.templateFamily) ?? 0) + 1)
    }
  }
  for (const [index, plate] of candidate.plates.entries()) {
    if (!plate || typeof plate !== 'object') {
      reasons.push(`Invalid plate at index: ${index}`)
      continue
    }
    for (const key of ['id', 'state', 'slug', 'displayName', 'image']) {
      if (typeof plate[key] !== 'string') reasons.push(`Plate ${index} requires string ${key}`)
    }
    if (!Array.isArray(plate.tags) || !plate.tags.every((tag: unknown) => typeof tag === 'string')) reasons.push(`Plate ${index} requires string array tags`)
    if (typeof plate.id === 'string') {
      if (ids.has(plate.id)) reasons.push(`Duplicate plate id: ${plate.id}`)
      ids.add(plate.id)
    }
    if (plate.isStandard === true && typeof plate.state === 'string') standards.set(plate.state, (standards.get(plate.state) ?? 0) + 1)
    const previous = baselinePlates.get(plate.id)
    if (groupingFields.some(field => plate[field] !== previous?.[field])) {
      for (const family of [previous?.templateFamily, plate.templateFamily]) {
        if (typeof family === 'string') touchedFamilies.add(family)
      }
    }
    if (plate.templateFamily !== undefined) {
      if (typeof plate.templateFamily !== 'string') reasons.push(`Plate ${index} requires string templateFamily`)
      else families.set(plate.templateFamily, (families.get(plate.templateFamily) ?? 0) + (plate.templateRole === 'template' ? 1 : 0))
    }
  }
  for (const plate of baseline.plates) {
    if (ids.has(plate.id)) continue
    if (!deleted.has(plate.id)) reasons.push(`Missing baseline plate: ${plate.id}`)
    if (plate.templateRole === 'template' && plate.templateFamily && families.has(plate.templateFamily)) touchedFamilies.add(plate.templateFamily)
  }
  for (const [state, count] of standards) if (count > 1) reasons.push(`Multiple standard plates in state: ${state}`)
  for (const family of touchedFamilies) {
    const count = families.get(family) ?? 0
    if (count > 1) reasons.push(`Family must have at most one template: ${family}`)
    else if (baselineTemplateCounts.get(family) === 1 && count !== 1) reasons.push(`Family must retain exactly one template: ${family}`)
  }
  return reasons
}
