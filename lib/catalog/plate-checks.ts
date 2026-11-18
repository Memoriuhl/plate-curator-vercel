import { familyRole } from './families'
import { COMPLETENESS_CHECK_KEYS } from './dashboard-types'
import type { Check, PlateChecks } from './dashboard-types'
import type { Plate } from './types'

export const minimumPlateTagCount = 3

/** Convert empty text to a missing value for plate completeness checks. */
const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null
/** Describe a field's completeness using its value and optional weakness signal. */
const check = (value: string | null, weak = false): Check => ({ status: value === null ? 'missing' : weak ? 'weak' : 'good', value })

/** Evaluate the plate fields the curator inspects when deciding what still needs work. */
export function plateChecks(plate: Plate, imageUrl: string | null): PlateChecks {
  const description = text(plate.description)
  const sourceUrl = text(plate.sourceUrl)
  const wikiUrl = text(plate.wikiUrl)
  const family = text(plate.templateFamily)
  const role = familyRole(plate)
  const facts = Array.isArray(plate.funFacts) && plate.funFacts.length > 0 ? plate.funFacts.map(fact => typeof fact === 'string' ? fact : fact.text).join('\n') : text(plate.funFacts)
  const rarity = typeof plate.rarity === 'object' && plate.rarity !== null && 'tier' in plate.rarity ? text(plate.rarity.tier) : text(plate.rarity)
  return {
    description: check(description, (description?.length ?? 0) < 40),
    funFacts: check(facts),
    link: check(sourceUrl ?? wikiUrl ?? plate.readMore?.[0]?.url ?? null, sourceUrl === null && !plate.readMore?.length),
    tags: check(plate.tags.length > 0 ? plate.tags.join(', ') : null, plate.tags.length < minimumPlateTagCount),
    family: check(family ? role ? `${family} · ${role}` : family : null, role === null),
    image: check(imageUrl),
    rarity: check(rarity),
  }
}

/** Require a good result for each field that counts toward plate completeness. */
export function isComplete(checks: PlateChecks): boolean {
  return COMPLETENESS_CHECK_KEYS.every(key => checks[key].status === 'good')
}
