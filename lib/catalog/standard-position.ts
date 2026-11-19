import { familyRole } from './families'
import type { Plate } from './types'

/** Check that an existing Standard flag was neither replaced nor demoted. */
export function preservesStandardFlags(
  before: readonly Plate[],
  after: readonly Plate[]
) {
  const flags = new Map(
    before
      .filter((plate) => plate.isStandard === true && !plate.deleted)
      .map((plate) => [plate.id, familyRole(plate)])
  )
  const next = after.filter(
    (plate) => plate.isStandard === true && !plate.deleted
  )
  return (
    next.length === flags.size &&
    next.every(
      (plate) =>
        flags.has(plate.id) &&
        (flags.get(plate.id) === 'variant' || familyRole(plate) !== 'variant')
    )
  )
}

/** Allow a draft to carry forward a legacy mismatch while preventing a new one. */
export function preservesStandardPosition(
  before: readonly Plate[],
  after: readonly Plate[],
  firstBefore: string | undefined,
  firstAfter: string | undefined
) {
  if (firstBefore !== firstAfter) return false
  const previous = before.find(({ id }) => id === firstBefore)
  const next = after.find(({ id }) => id === firstAfter)
  return (
    !!previous &&
    !!next &&
    (!!previous.deleted || !next.deleted) &&
    (familyRole(previous) !== 'template' || familyRole(next) === 'template') &&
    preservesStandardFlags(before, after)
  )
}

/** A repaired Standard is the single active flag and the first Template. */
export function hasValidStandard(
  plates: readonly Plate[],
  firstId: string | undefined
) {
  const standards = plates.filter(
    (plate) => plate.isStandard === true && !plate.deleted
  )
  return (
    standards.length === 1 &&
    standards[0].id === firstId &&
    familyRole(standards[0]) === 'template'
  )
}
