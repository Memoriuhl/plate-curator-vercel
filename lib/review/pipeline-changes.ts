import type { Plate } from '../catalog/types'
import { sameEditableValue } from './story'
import type { ProposedEdit } from './types'

export function retainedPipelineChanges(
  edit: ProposedEdit | null | undefined,
  plate: Plate,
): Pick<ProposedEdit, 'pipelineChanges' | 'pipelineRunIds'> {
  if (!edit) return {}
  const pipelineChanges = Object.fromEntries(Object.entries(edit.pipelineChanges ?? {})
    .filter(([field, change]) => sameEditableValue(field, change.value, plate[field])))
  return {
    ...(edit.pipelineRunIds?.length ? { pipelineRunIds: edit.pipelineRunIds } : {}),
    ...(Object.keys(pipelineChanges).length ? { pipelineChanges } : {}),
  }
}

export function hasPipelineHistory(edit: Pick<ProposedEdit, 'pipelineChanges' | 'pipelineRunIds'>) {
  return Boolean(edit.pipelineRunIds?.length || Object.keys(edit.pipelineChanges ?? {}).length)
}

export const pipelineImageFields = ['imageUrl', 'sourceUrl'] as const
