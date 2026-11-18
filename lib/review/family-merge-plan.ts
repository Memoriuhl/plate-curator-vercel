import type { EditableFields } from './types'

type Member = {
  id: string
  templateFamily?: string | null
  deleted?: boolean
  isStandard?: boolean
}

type Family = { template: Member; variants: Member[] }

export type FamilyMergeResult = {
  moved: string[]
  alreadyInFamily: number
  deleted: number
  standard: number
}

/**
 * Plan the family membership changes for selected plates while preserving the
 * destination template.
 */
export function planFamilyMerge(
  families: Family[],
  destination: Family,
  selectedIds: readonly string[],
  firstId?: string
) {
  const byId = new Map(
    families
      .flatMap((family) => [family.template, ...family.variants])
      .map((plate) => [plate.id, plate])
  )
  const children = new Map(
    families.map((family) => [family.template.id, family.variants])
  )
  const inFamily = new Set([
    destination.template.id,
    ...destination.variants.map((plate) => plate.id),
  ])
  /** Protect a state's standard and first plate from being moved into another family. */
  const protectedPlate = (plate: Member) =>
    plate.isStandard === true || plate.id === firstId
  const moving = new Set<string>()
  const result: FamilyMergeResult = {
    moved: [],
    alreadyInFamily: 0,
    deleted: 0,
    standard: 0,
  }
  for (const id of selectedIds) {
    const plate = byId.get(id)
    if (!plate) continue
    const variants = (children.get(id) ?? []).filter((plate) => !plate.deleted)
    if (plate.deleted) result.deleted++
    else if (inFamily.has(id)) result.alreadyInFamily++
    else if (protectedPlate(plate) || variants.some(protectedPlate))
      result.standard++
    else {
      moving.add(id)
      for (const child of variants) moving.add(child.id)
    }
  }

  const changes = new Map<string, EditableFields>()
  if (moving.size) {
    const parent = destination.template
    const templateFamily = parent.templateFamily || parent.id
    const fields: EditableFields = {
      templateRole: 'variant',
      variantOfPlateId: parent.id,
      templateFamily,
    }
    for (const id of moving) changes.set(id, fields)
    if (!parent.templateFamily) {
      changes.set(parent.id, { templateFamily, variantOfPlateId: null })
      for (const plate of destination.variants)
        if (!plate.deleted) changes.set(plate.id, fields)
    }
    result.moved = [...moving]
  }
  return { result, changes }
}
