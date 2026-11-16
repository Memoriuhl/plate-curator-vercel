import type { Snapshot } from '../catalog/types'

export function validateSnapshot(baseline: Snapshot, candidate: unknown): string[] {
  if (!candidate || typeof candidate !== 'object' || !('plates' in candidate) || !Array.isArray(candidate.plates)) {
    return ['Snapshot must contain a plates array']
  }
  const reasons: string[] = []
  if (!('version' in candidate) || candidate.version !== baseline.version + 1) reasons.push('Snapshot version must advance by one')
  const ids = new Set<string>()
  const standards = new Map<string, number>()
  const families = new Map<string, number>()
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
    if (plate.templateFamily !== undefined) {
      if (typeof plate.templateFamily !== 'string') reasons.push(`Plate ${index} requires string templateFamily`)
      else families.set(plate.templateFamily, (families.get(plate.templateFamily) ?? 0) + (plate.templateRole === 'template' ? 1 : 0))
    }
  }
  for (const plate of baseline.plates) if (!ids.has(plate.id)) reasons.push(`Missing baseline plate: ${plate.id}`)
  for (const [state, count] of standards) if (count > 1) reasons.push(`Multiple standard plates in state: ${state}`)
  for (const [family, count] of families) if (count !== 1) reasons.push(`Family must have exactly one template: ${family}`)
  return reasons
}
