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

/** Keep a long value readable in a tooltip by keeping its beginning. */
function brief(value: unknown, limit = 90): string {
  if (value === null || value === undefined || value === '') return 'none'
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text
}

/** Show a value change as "before → after", or just the new value when one was added. */
function transition(before: unknown, after: unknown) {
  const from = brief(before)
  const to = brief(after)
  return from === 'none' ? `Added: ${to}` : `${from} → ${to}`
}

/** The changed fields of the named field group. */
const changedOf = (entry: Entry, key: PlateChangeKey) => {
  const change = FIELD_CHANGES.find((item) => item.key === key)
  return change ? changedFields(entry, change) : []
}
const count = (value: unknown) => (Array.isArray(value) ? value.length : 0)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Describe what one kind of change did to a plate, one line per changed field, for the
 * tooltip on its Review and Publish icon.
 */
export function changeDetail(entry: Entry, key: PlateChangeKey): string[] {
  const { baseline: before, proposed: after } = entry
  switch (key) {
    case 'image':
      return ['New image']
    case 'description':
      return [transition(before.description, after.description)]
    case 'name':
      return [transition(before.displayName, after.displayName)]
    case 'funFacts': {
      const added = (Array.isArray(after.funFacts) ? after.funFacts : []).find(
        (fact) =>
          !(Array.isArray(before.funFacts) ? before.funFacts : []).some(
            (old) => JSON.stringify(old) === JSON.stringify(fact)
          )
      )
      const text =
        added && typeof added === 'object' ? added.text : (added ?? undefined)
      return [
        `${plural(count(before.funFacts), 'fact')} → ${plural(count(after.funFacts), 'fact')}`,
        ...(text ? [`New: ${brief(text)}`] : []),
      ]
    }
    case 'tags': {
      const delta = tagDelta(before.tags, after.tags)
      return [
        ...(delta.added.length ? [`Added: ${delta.added.join(', ')}`] : []),
        ...(delta.removed.length
          ? [`Removed: ${delta.removed.join(', ')}`]
          : []),
      ]
    }
    case 'link':
      return changedOf(entry, 'link').map((field) =>
        field === 'readMore'
          ? `Read more: ${plural(count(before.readMore), 'link')} → ${plural(count(after.readMore), 'link')}`
          : `${field === 'wikiUrl' ? 'Reference page' : 'Image source'}: ${transition(before[field], after[field])}`
      )
    case 'family':
      return changedOf(entry, 'family').map((field) =>
        field === 'isStandard'
          ? `Standard: ${before.isStandard ? 'yes' : 'no'} → ${after.isStandard ? 'yes' : 'no'}`
          : `${{ templateFamily: 'Family', templateRole: 'Role', variantOfPlateId: 'Variant of' }[field] ?? field}: ${transition(before[field], after[field])}`
      )
    case 'firstIssued':
      return [transition(before.firstIssuedYear, after.firstIssuedYear)]
    case 'colors':
      return changedOf(entry, 'colors').map(
        (field) =>
          `${field === 'colorDetail' ? 'Background' : 'Broad color'}: ${transition(before[field], after[field])}`
      )
    case 'order':
      return entry.order
        ? [
            `Position ${entry.order.before + 1} → ${entry.order.after + 1} of ${entry.order.total}`,
          ]
        : [
            `Position ${(before.sortOrder ?? 0) + 1} → ${(after.sortOrder ?? 0) + 1}`,
          ]
    case 'deleted':
      return ['Removed from the catalog at the next Publish']
    case 'restored':
      return ['Returns to the catalog at the next Publish']
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
