import {
  PLATE_CHECK_KEYS,
  COMPLETENESS_CHECK_KEYS,
  type CheckStatus,
  type PlateCheckKey,
  type PlateCardData,
} from '@/lib/catalog/dashboard-types'

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

export type FamilyPlate = Pick<
  PlateCardData,
  | 'id'
  | 'revision'
  | 'displayName'
  | 'imageUrl'
  | 'templateRole'
  | 'templateFamily'
  | 'variantOfPlateId'
  | 'isStandard'
  | 'sortOrder'
  | 'tags'
> & { checks: Record<PlateCheckKey, CheckStatus> }

export type FilterCounts = {
  all: number
  nofunfacts: number
  undertagged: number
  generic: number
}

export function filterCounts(plates: PlateCardData[]): FilterCounts {
  return plates.reduce(
    (counts, plate) => ({
      all: counts.all + 1,
      nofunfacts:
        counts.nofunfacts + Number(plate.checks.funFacts.status === 'missing'),
      undertagged:
        counts.undertagged + Number(plate.checks.tags.status !== 'good'),
      generic:
        counts.generic + Number(plate.checks.description.status !== 'good'),
    }),
    { all: 0, nofunfacts: 0, undertagged: 0, generic: 0 },
  )
}

export function projectFamilyPlate(plate: PlateCardData): FamilyPlate {
  const {
    id,
    revision,
    displayName,
    imageUrl,
    templateRole,
    templateFamily,
    variantOfPlateId,
    isStandard,
    sortOrder,
    tags,
  } = plate
  return {
    id,
    revision,
    displayName,
    imageUrl,
    templateRole,
    templateFamily,
    variantOfPlateId,
    isStandard,
    sortOrder,
    tags,
    checks: Object.fromEntries(
      PLATE_CHECK_KEYS.map((key) => [key, plate.checks[key].status]),
    ) as FamilyPlate['checks'],
  }
}

export function expandFamilyPlate(plate: FamilyPlate): PlateCardData {
  const [state, ...slug] = plate.id.split('.')
  return {
    ...plate,
    state,
    slug: slug.join('.'),
    imageSize: { width: 320, height: 160 },
    complete: COMPLETENESS_CHECK_KEYS.every(
      (key) => plate.checks[key] === 'good',
    ),
    checks: Object.fromEntries(
      PLATE_CHECK_KEYS.map((key) => [
        key,
        { status: plate.checks[key], value: null },
      ]),
    ) as PlateCardData['checks'],
  }
}
