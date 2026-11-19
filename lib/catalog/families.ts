import type { Plate } from './types'

/** Resolve the family role from explicit catalog data or legacy template references. */
export function familyRole(
  plate: Pick<Plate, 'templateRole' | 'isTemplate' | 'variantOfPlateId'>
) {
  if (plate.templateRole) return plate.templateRole
  if (typeof plate.isTemplate === 'boolean')
    return plate.isTemplate ? 'template' : 'variant'
  return plate.variantOfPlateId ? 'variant' : null
}

type FamilyMember = {
  id: string
  state: string
  sortOrder?: number
  templateRole?: 'template' | 'variant' | null
  templateFamily?: string | null
  variantOfPlateId?: string | null
}

/**
 * Collect templates and their variants within each state for the curator's family view.
 */
export function groupFamilies<T extends FamilyMember>(plates: readonly T[]) {
  /**
   * Sort plates by catalog position with a stable ID tie breaker when positions match.
   */
  const compare = (a: T, b: T) =>
    (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity) ||
    a.id.localeCompare(b.id)
  const ordered = [...plates].sort(compare)
  const heads = new Map<string, T>()
  const byId = new Map(ordered.map((plate) => [plate.id, plate]))
  /**
   * Scope a family key by both state and family label because labels can recur across
   * states.
   */
  const familyKey = (plate: T) =>
    JSON.stringify([plate.state, plate.templateFamily])
  for (const plate of ordered) {
    if (
      plate.templateFamily &&
      plate.templateRole === 'template' &&
      !heads.has(familyKey(plate))
    ) {
      heads.set(familyKey(plate), plate)
    }
  }
  const families = new Map<string, { template: T; variants: T[] }>()
  for (const plate of ordered) {
    const linked = plate.variantOfPlateId
      ? byId.get(plate.variantOfPlateId)
      : undefined
    const explicitParent =
      linked?.state === plate.state && linked.templateRole !== 'variant'
        ? linked
        : undefined
    const parent =
      plate.templateRole === 'variant'
        ? (explicitParent ??
          (plate.templateFamily ? heads.get(familyKey(plate)) : undefined))
        : undefined
    const head = parent ?? plate
    let family = families.get(head.id)
    if (!family) {
      family = { template: head, variants: [] }
      families.set(head.id, family)
    }
    if (head !== plate) family.variants.push(plate)
  }
  return [...families.values()].sort((a, b) => compare(a.template, b.template))
}

/** Group a state whose plates are already in effective catalog or draft order. */
export function groupFamiliesInOrder(plates: readonly Plate[]) {
  return groupFamilies(
    plates.map((plate, sortOrder) => ({
      ...plate,
      sortOrder,
      templateRole: familyRole(plate),
    }))
  )
}
