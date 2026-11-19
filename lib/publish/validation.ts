import { validTarget } from './allocation'
import type { Plate, Snapshot } from '../catalog/types'
import { familyRole } from '../catalog/families'
import { orderedStatePlates } from '../catalog/order'
import {
  checkStandardOrder,
  preservesStandardFlags,
} from '../catalog/standard-position'
import {
  colorFieldKeys,
  parseColorFields,
  parseStoryFields,
  storyUrl,
} from '../review/fields'
import { sameEditableValue, storyFieldKeys } from '../review/story'

const groupingFields = [
  'templateFamily',
  'templateRole',
  'variantOfPlateId',
] as const

/**
 * Validate a candidate snapshot against baseline membership, ordering and plate
 * requirements before publishing.
 */
export function validateSnapshot(
  baseline: Snapshot,
  candidate: unknown,
  deleted: ReadonlySet<string> = new Set(),
  stateOrders: Record<string, string[]> = {},
  baselineOrders: Record<string, string[]> = {}
): string[] {
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !('plates' in candidate) ||
    !Array.isArray(candidate.plates)
  ) {
    return ['Snapshot must contain a plates array']
  }
  const reasons: string[] = []
  if (
    !('version' in candidate) ||
    typeof candidate.version !== 'number' ||
    !validTarget(baseline.version, candidate.version)
  )
    reasons.push('Snapshot version must be a greater safe integer')
  const ids = new Set<string>()
  const platesByState = new Map<string, Plate[]>()
  const families = new Map<string, number>()
  const baselinePlates = new Map(
    baseline.plates.map((plate) => [plate.id, plate])
  )
  const baselineTemplateCounts = new Map<string, number>()
  const baselineFamilies = new Set(
    baseline.plates.flatMap((plate) =>
      typeof plate.templateFamily === 'string' ? [plate.templateFamily] : []
    )
  )
  const touchedFamilies = new Set<string>()
  for (const plate of baseline.plates) {
    if (
      typeof plate.templateFamily === 'string' &&
      familyRole(plate) === 'template'
    ) {
      baselineTemplateCounts.set(
        plate.templateFamily,
        (baselineTemplateCounts.get(plate.templateFamily) ?? 0) + 1
      )
    }
  }
  for (const [index, plate] of candidate.plates.entries()) {
    if (!plate || typeof plate !== 'object') {
      reasons.push(`Invalid plate at index: ${index}`)
      continue
    }
    for (const key of ['id', 'state', 'slug', 'displayName', 'image']) {
      if (typeof plate[key] !== 'string')
        reasons.push(`Plate ${index} requires string ${key}`)
    }
    if (
      !Array.isArray(plate.tags) ||
      !plate.tags.every((tag: unknown) => typeof tag === 'string')
    )
      reasons.push(`Plate ${index} requires string array tags`)
    if (typeof plate.id === 'string') {
      if (ids.has(plate.id)) reasons.push(`Duplicate plate id: ${plate.id}`)
      ids.add(plate.id)
    }
    if (typeof plate.state === 'string' && typeof plate.id === 'string') {
      const state = platesByState.get(plate.state)
      if (state) state.push(plate)
      else platesByState.set(plate.state, [plate])
    }
    const previous = baselinePlates.get(plate.id)
    for (const key of colorFieldKeys) {
      if (
        !sameEditableValue(key, previous?.[key], plate[key]) &&
        plate[key] !== undefined &&
        (plate[key] === null ||
          parseColorFields({ [key]: plate[key] }) === null)
      )
        reasons.push(`Plate ${index} has invalid ${key}`)
    }
    if (plate.imageUrl && plate.imageUrl !== previous?.imageUrl)
      reasons.push('Image candidate needs upload before publishing')
    for (const key of [...storyFieldKeys, 'sourceUrl'] as const) {
      if (
        !sameEditableValue(key, previous?.[key], plate[key]) &&
        plate[key] !== undefined &&
        (plate[key] === null ||
          (key === 'sourceUrl'
            ? storyUrl(plate[key]) === null
            : parseStoryFields({ [key]: plate[key] }) === null))
      ) {
        reasons.push(`Plate ${index} has invalid ${key}`)
      }
    }
    if (groupingFields.some((field) => plate[field] !== previous?.[field])) {
      for (const family of [previous?.templateFamily, plate.templateFamily]) {
        if (typeof family === 'string') touchedFamilies.add(family)
      }
    }
    if (plate.templateFamily !== undefined) {
      if (typeof plate.templateFamily !== 'string')
        reasons.push(`Plate ${index} requires string templateFamily`)
      else
        families.set(
          plate.templateFamily,
          (families.get(plate.templateFamily) ?? 0) +
            (familyRole(plate) === 'template' ? 1 : 0)
        )
    }
  }
  for (const plate of baseline.plates) {
    if (ids.has(plate.id)) continue
    if (!deleted.has(plate.id))
      reasons.push(`Missing baseline plate: ${plate.id}`)
    if (
      familyRole(plate) === 'template' &&
      plate.templateFamily &&
      families.has(plate.templateFamily)
    )
      touchedFamilies.add(plate.templateFamily)
  }
  for (const plate of candidate.plates) {
    if (
      plate &&
      typeof plate === 'object' &&
      typeof plate.variantOfPlateId === 'string' &&
      !ids.has(plate.variantOfPlateId)
    )
      reasons.push(
        `Missing Variant parent: ${plate.variantOfPlateId} (${plate.id})`
      )
  }
  for (const family of touchedFamilies) {
    const count = families.get(family) ?? 0
    if (count > 1)
      reasons.push(`Family must have at most one template: ${family}`)
    else if (
      (!baselineFamilies.has(family) ||
        baselineTemplateCounts.get(family) === 1) &&
      families.has(family) &&
      count === 0
    )
      reasons.push(`Family must retain exactly one template: ${family}`)
  }
  const baselineByState = Map.groupBy(baseline.plates, (plate) => plate.state)
  for (const state of new Set([
    ...Object.keys(stateOrders),
    ...baselineByState.keys(),
    ...platesByState.keys(),
  ])) {
    const before = baselineByState.get(state) ?? []
    const after = platesByState.get(state) ?? []
    const flagsPreserved = preservesStandardFlags(before, after)
    if (
      !flagsPreserved &&
      after.filter((plate) => plate.isStandard === true && !plate.deleted)
        .length > 1
    ) {
      reasons.push(`Multiple standard plates in state: ${state}`)
      if (!stateOrders[state]) continue
    }
    if (!stateOrders[state] && flagsPreserved) continue
    const standard = checkStandardOrder(
      orderedStatePlates({ version: baseline.version, plates: before }, state, {
        stateOrder: baselineOrders,
        stateProgress: {},
      }),
      orderedStatePlates({ version: baseline.version, plates: after }, state, {
        stateOrder: stateOrders[state] ? stateOrders : baselineOrders,
        stateProgress: {},
      })
    )
    if (!standard.valid)
      reasons.push('Standard must be the first Template in state: ' + state)
  }
  return reasons
}
