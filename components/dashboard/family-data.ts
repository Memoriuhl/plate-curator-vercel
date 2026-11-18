import {
  PLATE_CHECK_KEYS,
  COMPLETENESS_CHECK_KEYS,
  type CheckStatus,
  type PlateCheckKey,
  type PlateCardData,
} from '@/lib/catalog/dashboard-types'

import { groupFamilies } from '@/lib/catalog/families'
export { groupFamilies } from '@/lib/catalog/families'

/**
 * Index displayed variants by ID so completeness filters can recognize attached family
 * members.
 */
export function attachedFamilyIds(plates: readonly PlateCardData[], families = groupFamilies(plates)) {
  return new Set(families.flatMap(family => family.variants.map(plate => plate.id)))
}

const EMPTY_IDS: ReadonlySet<string> = new Set()

/** Filter a plate by search text, workspace status and the active completeness check. */
export function matchesPlate(
  plate: PlateCardData,
  show: string,
  query: string,
  changed: ReadonlySet<string>,
  standardIds?: ReadonlySet<string>,
  attachedIds: ReadonlySet<string> = EMPTY_IDS,
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
  if (NEEDS_WORK_KEYS.has(show)) return matchesCheck(plate, show, attachedIds)
  switch (show) {
    case 'changed':
      return changed.has(plate.id)
    default:
      return true
  }
}

export type FamilyPlate = Pick<
  PlateCardData,
  | 'deleted'
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

/** Evaluate one needs-work check against the plate and its current family attachment. */
function matchesCheck(plate: PlateCardData, key: string, attachedIds: ReadonlySet<string>): boolean {
  switch (key) {
    case 'missingDescription': return plate.checks.description.status === 'missing'
    case 'missingImage': return plate.checks.image.status !== 'good'
    case 'undertagged': return plate.checks.tags.status !== 'good'
    case 'noFamily': return plate.templateRole !== 'template' && !attachedIds.has(plate.id)
    case 'generic': return plate.checks.description.status === 'weak'
    case 'nofunfacts': return plate.checks.funFacts.status === 'missing'
    default: return false
  }
}

type StateStandards = { standards: string[]; candidate: PlateCardData }
/** Track existing standards and the best replacement candidate while scanning a state. */
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
/**
 * Select plate IDs that need attention when a state has missing or duplicate standards.
 */
function standardFixIds(states: Map<string, StateStandards>) {
  return [...states.values()].flatMap(({ standards, candidate }) =>
    standards.length === 1 && standards[0] === candidate.id ? [] : standards.length ? standards : [candidate.id])
}

/**
 * Find plates needing the requested check before applying the workspace's other filters.
 */
function uncheckedPlateIdsForCheck(plates: readonly PlateCardData[], key: string, attachedIds: ReadonlySet<string>): string[] {
  if (key === 'standardPlate') {
    const states = new Map<string, StateStandards>()
    for (const plate of plates) recordStandard(states, plate)
    return standardFixIds(states)
  }
  if (key === 'all') return plates.map(plate => plate.id)
  return plates.filter(plate => {
    if (PLATE_CHECK_KEYS.includes(key as PlateCheckKey)) return plate.checks[key as PlateCheckKey].status !== 'good'
    return matchesCheck(plate, key, attachedIds)
  }).map(plate => plate.id)
}

/** Return the IDs for a needs-work group that also match the current dashboard view. */
export function plateIdsForCheck(plates: readonly PlateCardData[], key: string, query = '', attachedIds = attachedFamilyIds(plates)): string[] {
  const ids = uncheckedPlateIdsForCheck(plates, key, attachedIds)
  if (!query.trim()) return ids
  const matching = new Set(ids)
  const changed = new Set<string>()
  return plates.filter(plate => matching.has(plate.id) && matchesPlate(plate, 'all', query, changed)).map(plate => plate.id)
}

/**
 * Count the plates matching each needs-work group using the same checks as the filtered
 * grid.
 */
export function filterCounts(plates: readonly PlateCardData[], attachedIds = attachedFamilyIds(plates)): FilterCounts {
  const groups = Object.fromEntries(NEEDS_WORK_CHECKS.map(({ key }) =>
    [key, { missing: 0, weak: 0, total: 0 }])) as FilterCounts['groups']
  const states = new Map<string, StateStandards>()
  for (const plate of plates) {
    recordStandard(states, plate)
    for (const { key, checkKey } of NEEDS_WORK_CHECKS) {
      if (!matchesCheck(plate, key, attachedIds)) continue
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

/**
 * Project catalog card data into the compact family grid record used by the workspace.
 */
export function projectFamilyPlate(plate: PlateCardData): FamilyPlate {
  const {
    deleted,
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
    deleted,
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

/**
 * Expand a compact family record back into the card shape needed by editing and
 * selection.
 */
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
