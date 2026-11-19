import type { BatchDetail } from '@/lib/client/hooks'
import type { Plate } from '@/lib/catalog/types'
import { JURISDICTIONS } from '@/lib/catalog/jurisdictions'
import { sameEditableValue } from '@/lib/review/story'

type Entry = BatchDetail['plates'][number]

export type PlateChangeKey =
  | 'image'
  | 'description'
  | 'name'
  | 'funFacts'
  | 'tags'
  | 'link'
  | 'family'
  | 'firstIssued'
  | 'colors'
  | 'order'
  | 'deleted'
  | 'restored'

export type PlateChange = {
  key: PlateChangeKey
  label: string
  fields: readonly string[]
}

/** Field groups in the order Review shows their icons. */
export const FIELD_CHANGES: readonly PlateChange[] = [
  { key: 'image', label: 'Image', fields: ['image', 'imageUrl'] },
  { key: 'description', label: 'Description', fields: ['description'] },
  { key: 'name', label: 'Name', fields: ['displayName'] },
  { key: 'funFacts', label: 'Fun facts', fields: ['funFacts'] },
  { key: 'tags', label: 'Tags', fields: ['tags'] },
  {
    key: 'link',
    label: 'Link',
    fields: ['wikiUrl', 'readMore', 'sourceUrl'],
  },
  {
    key: 'family',
    label: 'Family',
    fields: [
      'templateFamily',
      'templateRole',
      'variantOfPlateId',
      'isStandard',
    ],
  },
  { key: 'firstIssued', label: 'First issued', fields: ['firstIssuedYear'] },
  { key: 'colors', label: 'Colors', fields: ['colorDetail', 'lineageColor'] },
]

/** True when the entry moves the plate within its state. */
function moved({ baseline, proposed, order }: Entry) {
  return !!order || baseline.sortOrder !== proposed.sortOrder
}

/** The fields of one group whose values differ between baseline and proposal. */
export function changedFields(entry: Entry, change: PlateChange) {
  return change.fields.filter(
    (field) =>
      !sameEditableValue(field, entry.baseline[field], entry.proposed[field])
  )
}

/** Every kind of change an entry makes, one per kind, in the Review icon order. */
export function plateChanges(entry: Entry): PlateChange[] {
  const changes = FIELD_CHANGES.filter(
    (change) => changedFields(entry, change).length > 0
  )
  if (moved(entry))
    changes.push({ key: 'order', label: 'Order', fields: ['sortOrder'] })
  if (!entry.baseline.deleted && entry.proposed.deleted)
    changes.push({ key: 'deleted', label: 'Deleted', fields: ['deleted'] })
  if (entry.baseline.deleted && !entry.proposed.deleted)
    changes.push({ key: 'restored', label: 'Restored', fields: ['deleted'] })
  return changes
}

/** The tags a change added and removed, with the counts before and after. */
export function tagDelta(before: string[] = [], after: string[] = []) {
  return {
    added: after.filter((tag) => !before.includes(tag)),
    removed: before.filter((tag) => !after.includes(tag)),
    from: before.length,
    to: after.length,
  }
}

/**
 * The template plate of a plate's family: the plate it is a variant of, or itself when
 * it is the template. Families are named after their template plate.
 */
export function familyTemplateId(plate: Plate) {
  if (plate.variantOfPlateId) return plate.variantOfPlateId
  if (plate.templateRole === 'template' || plate.isTemplate) return plate.id
  return null
}

export type PublishPlate = {
  entry: Entry
  changes: PlateChange[]
  edited: boolean
  moved: boolean
  removed: boolean
}

export type PublishFilter = 'all' | 'edited' | 'moved' | 'removed'

const notEdits: PlateChangeKey[] = ['order', 'deleted']

/** Classify one entry for the Publish list, or skip it when it changes nothing. */
function publishPlate(entry: Entry): PublishPlate | null {
  const changes = plateChanges(entry)
  if (!changes.length) return null
  const keys = changes.map((change) => change.key)
  return {
    entry,
    changes,
    edited: keys.some((key) => !notEdits.includes(key)),
    moved: keys.includes('order'),
    removed: keys.includes('deleted'),
  }
}

/** Count the plates in a list that make each kind of change. */
function countKinds(plates: PublishPlate[]) {
  return {
    edited: plates.filter((plate) => plate.edited).length,
    moved: plates.filter((plate) => plate.moved).length,
    removed: plates.filter((plate) => plate.removed).length,
  }
}

/**
 * Group a draft's changed plates by state for Publish, with counts by kind and the
 * number of plates each person changed. Entries that change nothing are left out, so
 * the list matches the per-state counts.
 */
export function publishChanges(entries: readonly Entry[]) {
  const plates = entries.flatMap((entry) => publishPlate(entry) ?? [])
  const byState = new Map<string, PublishPlate[]>()
  for (const plate of plates) {
    const code = plate.entry.baseline.state
    byState.set(code, [...(byState.get(code) ?? []), plate])
  }
  const authors = new Map<
    string,
    { uid: string; name: string; plates: number }
  >()
  for (const { entry } of plates) {
    const uid = entry.edit?.authorId
    if (!uid) continue
    const author = authors.get(uid) ?? {
      uid,
      name: entry.edit?.authorName || 'A curator',
      plates: 0,
    }
    authors.set(uid, { ...author, plates: author.plates + 1 })
  }
  return {
    states: [...byState]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, statePlates]) => ({
        code,
        name: JURISDICTIONS[code] ?? code,
        plates: statePlates,
        ...countKinds(statePlates),
      })),
    counts: { all: plates.length, ...countKinds(plates) },
    authors: [...authors.values()].sort(
      (a, b) => b.plates - a.plates || a.name.localeCompare(b.name)
    ),
  }
}

/** Keep a plate that makes the filtered kind of change and matches the search text. */
export function matchesPublishFilter(
  plate: PublishPlate,
  filter: PublishFilter,
  query: string
) {
  if (filter !== 'all' && !plate[filter]) return false
  const text = query.trim().toLowerCase()
  if (!text) return true
  const { baseline, proposed } = plate.entry
  return [
    proposed.displayName,
    baseline.displayName,
    baseline.id,
    baseline.state,
    JURISDICTIONS[baseline.state] ?? '',
    ...plate.changes.map((change) => change.label),
  ].some((value) => value.toLowerCase().includes(text))
}
