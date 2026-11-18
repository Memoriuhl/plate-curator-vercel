import type { Plate } from '../catalog/types'
import type { GroupSuggestion } from '../jobs/specialized-suggestions'

export const groupSelectionLimit = 25

/**
 * Determine whether the selected plates form a complete grouping scope within one state.
 */
export function completeGroupScope(
  selected: Plate[],
  statePlates: Plate[]
): boolean {
  const ids = new Set(selected.map((plate) => plate.id))
  if (
    !selected.length ||
    selected.length > groupSelectionLimit ||
    ids.size !== selected.length ||
    new Set(selected.map((plate) => plate.state)).size !== 1 ||
    selected.some(
      (plate) =>
        plate.deleted || !statePlates.some((member) => member.id === plate.id)
    )
  )
    return false
  const families = new Set(
    selected.map((plate) => plate.templateFamily).filter(Boolean)
  )
  return (
    statePlates.every(
      (plate) =>
        plate.deleted ||
        ids.has(plate.id) ||
        (!families.has(plate.templateFamily) &&
          !ids.has(plate.variantOfPlateId ?? ''))
    ) &&
    selected.every(
      (plate) => !plate.variantOfPlateId || ids.has(plate.variantOfPlateId)
    )
  )
}

/**
 * Check that the proposed grouping context preserves the current standard and relevant
 * family structure.
 */
export function validGroupContext(
  suggestion: GroupSuggestion,
  selected: Plate[],
  statePlates: Plate[],
  standardId?: string
): boolean {
  if (!completeGroupScope(selected, statePlates)) return false
  const ids = new Set(selected.map((plate) => plate.id))
  if (
    suggestion.scope.length !== ids.size ||
    suggestion.scope.some((member) => !ids.has(member.plateId))
  )
    return false
  if (
    suggestion.proposals.some(
      (value) =>
        value.plateId === standardId && value.fields.templateRole !== 'template'
    )
  )
    return false
  const templates = suggestion.proposals.filter(
    (value) => value.fields.templateRole === 'template'
  )
  if (templates.some((value) => value.fields.templateFamily !== value.plateId))
    return false
  const newFamilies = new Set(
    templates.map((value) => value.fields.templateFamily)
  )
  return !statePlates.some(
    (plate) =>
      !plate.deleted &&
      !ids.has(plate.id) &&
      newFamilies.has(plate.templateFamily ?? '')
  )
}
