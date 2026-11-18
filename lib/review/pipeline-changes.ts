import type { Plate } from '../catalog/types'
import { sameEditableValue } from './story'
import type { EditableFields, ProposedEdit } from './types'

export function retainedPipelineChanges(
  edit: ProposedEdit | null | undefined,
  fields: EditableFields,
  plate: Plate,
): Pick<ProposedEdit, 'pipelineChanges' | 'pipelineRunIds'> {
  if (!edit) return {}
  const pipelineChanges = Object.fromEntries(Object.entries(edit.pipelineChanges ?? {})
    .filter(([field, change]) => Object.hasOwn(fields, field) && sameEditableValue(field, change.value, plate[field])))
  return {
    ...(edit.pipelineRunIds?.length ? { pipelineRunIds: edit.pipelineRunIds } : {}),
    ...(Object.keys(pipelineChanges).length ? { pipelineChanges } : {}),
  }
}
