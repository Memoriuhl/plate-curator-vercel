import type { PlateCardData } from '@/lib/catalog/dashboard-types'

export function groupFamilies(plates: PlateCardData[]) {
  const ordered = [...plates].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
  )
  const templates = ordered.filter((plate) => plate.templateRole === 'template')
  const byId = new Map(
    ordered
      .filter((plate) => plate.templateRole !== 'variant')
      .map((plate) => [plate.id, plate]),
  )
  const byFamily = new Map(
    templates
      .filter((plate) => plate.templateFamily)
      .map((plate) => [plate.templateFamily, plate]),
  )
  const families = new Map<
    string,
    { template: PlateCardData; variants: PlateCardData[] }
  >()
  for (const plate of ordered) {
    const parent =
      plate.templateRole === 'variant'
        ? (byId.get(plate.variantOfPlateId ?? '') ??
          byFamily.get(plate.templateFamily))
        : undefined
    const head = parent ?? plate
    if (!families.has(head.id))
      families.set(head.id, { template: head, variants: [] })
    if (parent) families.get(head.id)!.variants.push(plate)
  }
  return [...families.values()].sort(
    (a, b) =>
      a.template.sortOrder - b.template.sortOrder ||
      a.template.id.localeCompare(b.template.id),
  )
}

export function matchesPlate(
  plate: PlateCardData,
  show: string,
  query: string,
  changed: ReadonlySet<string>,
) {
  const search = query.trim().toLowerCase()
  if (
    search &&
    ![plate.id, plate.displayName, ...plate.tags].some((value) =>
      value.toLowerCase().includes(search),
    )
  )
    return false
  switch (show) {
    case 'changed':
      return changed.has(plate.id)
    case 'nofunfacts':
      return plate.checks.funFacts.status === 'missing'
    case 'undertagged':
      return plate.checks.tags.status !== 'good'
    case 'generic':
      return plate.checks.description.status !== 'good'
    default:
      return true
  }
}
