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
  standardIds?: ReadonlySet<string>,
) {
  const search = query.trim().toLowerCase()
  if (
    search &&
    ![plate.id, plate.displayName, ...plate.tags].some((value) =>
      value.toLowerCase().includes(search),
    )
  )
    return false
  if (PLATE_CHECK_KEYS.includes(show as PlateCheckKey))
    return plate.checks[show as PlateCheckKey].status !== 'good'
  if (show === 'standardPlate') return standardIds?.has(plate.id) ?? false
  if (NEEDS_WORK_KEYS.has(show)) return matchesCheck(plate, show)
  switch (show) {
    case 'changed':
      return changed.has(plate.id)
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

export const NEEDS_WORK_CHECKS = [
  { key: 'missingDescription', label: 'No description', checkKey: 'description' },
  { key: 'missingImage', label: 'No image', checkKey: 'image' },
  { key: 'undertagged', label: 'Under-tagged', checkKey: 'tags' },
  { key: 'noFamily', label: 'No family', checkKey: 'family' },
  { key: 'generic', label: 'Generic description', checkKey: 'description' },
  { key: 'standardPlate', label: 'Standard plate issues', checkKey: 'family' },
  { key: 'nofunfacts', label: 'No fun facts', checkKey: 'funFacts' },
] as const satisfies readonly { key: string; label: string; checkKey: PlateCheckKey }[]

const NEEDS_WORK_KEYS = new Set<string>(NEEDS_WORK_CHECKS.map(check => check.key))

export type NeedsWorkKey = (typeof NEEDS_WORK_CHECKS)[number]['key']
type CheckGroup = { missing: number; weak: number; total: number }
export type FilterCounts = {
  all: number
  nofunfacts: number
  undertagged: number
  generic: number
  groups: Record<NeedsWorkKey, CheckGroup>
}

function matchesCheck(plate: PlateCardData, key: string): boolean {
  switch (key) {
    case 'missingDescription': return plate.checks.description.status === 'missing'
    case 'missingImage': return plate.checks.image.status !== 'good'
    case 'undertagged': return plate.checks.tags.status !== 'good'
    case 'noFamily': return plate.templateRole !== 'template' && !plate.variantOfPlateId
    case 'generic': return plate.checks.description.status === 'weak'
    case 'nofunfacts': return plate.checks.funFacts.status === 'missing'
    default: return false
  }
}

type StateStandards = { standards: string[]; candidate: PlateCardData }
function recordStandard(states: Map<string, StateStandards>, plate: PlateCardData) {
  let state = states.get(plate.state)
  if (!state) {
    state = { standards: [], candidate: plate }
    states.set(plate.state, state)
  }
  if (plate.isStandard) state.standards.push(plate.id)
  if (plate.sortOrder < state.candidate.sortOrder ||
    (plate.sortOrder === state.candidate.sortOrder && plate.id < state.candidate.id)) state.candidate = plate
}
function standardFixIds(states: Map<string, StateStandards>) {
  return [...states.values()].flatMap(({ standards, candidate }) =>
    standards.length === 1 ? [] : standards.length ? standards : [candidate.id])
}

function uncheckedPlateIdsForCheck(plates: readonly PlateCardData[], key: string): string[] {
  if (key === 'standardPlate') {
    const states = new Map<string, StateStandards>()
    for (const plate of plates) recordStandard(states, plate)
    return standardFixIds(states)
  }
  if (key === 'all') return plates.map(plate => plate.id)
  return plates.filter(plate => {
    if (PLATE_CHECK_KEYS.includes(key as PlateCheckKey)) return plate.checks[key as PlateCheckKey].status !== 'good'
    return matchesCheck(plate, key)
  }).map(plate => plate.id)
}

export function plateIdsForCheck(plates: readonly PlateCardData[], key: string, query = ''): string[] {
  const ids = uncheckedPlateIdsForCheck(plates, key)
  if (!query.trim()) return ids
  const matching = new Set(ids)
  const changed = new Set<string>()
  return plates.filter(plate => matching.has(plate.id) && matchesPlate(plate, 'all', query, changed)).map(plate => plate.id)
}

export function filterCounts(plates: readonly PlateCardData[]): FilterCounts {
  const groups = Object.fromEntries(NEEDS_WORK_CHECKS.map(({ key }) =>
    [key, { missing: 0, weak: 0, total: 0 }])) as FilterCounts['groups']
  const states = new Map<string, StateStandards>()
  for (const plate of plates) {
    recordStandard(states, plate)
    for (const { key, checkKey } of NEEDS_WORK_CHECKS) {
      if (!matchesCheck(plate, key)) continue
      const group = groups[key]
      group.total++
      const status = key === 'noFamily' ? 'missing' : plate.checks[checkKey].status
      if (status !== 'good') group[status]++
    }
  }
  const standardIds = standardFixIds(states)
  const missingStandardStates = [...states.values()].filter(state => !state.standards.length).length
  groups.standardPlate = {
    total: standardIds.length,
    missing: missingStandardStates, weak: standardIds.length - missingStandardStates,
  }
  return { all: plates.length, nofunfacts: groups.nofunfacts.total,
    undertagged: groups.undertagged.total, generic: groups.generic.total, groups }
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
