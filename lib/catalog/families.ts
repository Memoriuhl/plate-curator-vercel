import type { Plate } from './types'

export function familyRole(plate: Pick<Plate, 'templateRole' | 'isTemplate'>) {
  return plate.templateRole ?? (typeof plate.isTemplate === 'boolean' ? plate.isTemplate ? 'template' : 'variant' : null)
}

type FamilyMember = {
  id: string
  state: string
  sortOrder?: number
  templateRole?: 'template' | 'variant' | null
  templateFamily?: string | null
  variantOfPlateId?: string | null
}

export function groupFamilies<T extends FamilyMember>(plates: readonly T[]) {
  const compare = (a: T, b: T) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity) || a.id.localeCompare(b.id)
  const ordered = [...plates].sort(compare)
  const heads = new Map<string, T>()
  const byId = new Map(ordered.map(plate => [plate.id, plate]))
  const familyKey = (plate: T) => JSON.stringify([plate.state, plate.templateFamily])
  for (const plate of ordered) {
    if (plate.templateFamily && plate.templateRole === 'template' && !heads.has(familyKey(plate))) {
      heads.set(familyKey(plate), plate)
    }
  }
  const families = new Map<string, { template: T; variants: T[] }>()
  for (const plate of ordered) {
    const linked = plate.variantOfPlateId ? byId.get(plate.variantOfPlateId) : undefined
    const explicitParent = linked?.state === plate.state && linked.templateRole !== 'variant' ? linked : undefined
    const parent = plate.templateRole === 'variant'
      ? explicitParent ?? (plate.templateFamily ? heads.get(familyKey(plate)) : undefined)
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
