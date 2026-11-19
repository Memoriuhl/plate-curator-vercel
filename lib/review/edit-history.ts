import { editableKeys } from './fields'
import { sameEditableValue } from './story'
import type { ProposedEdit, ReviewBatch } from './types'

/** A plate's version survives removing its last pending field. */
export function plateEditVersion(
  batch: ReviewBatch | undefined,
  plateId: string
): number {
  return batch?.plateEditVersions?.[plateId] ?? 0
}

/** Carry forward the author only for field values that are still present. */
export function recordEditAuthors(
  edit: ProposedEdit,
  before?: ProposedEdit | null
): ProposedEdit {
  const fieldAuthors: NonNullable<ProposedEdit['fieldAuthors']> = {}
  for (const field of editableKeys) {
    if (!Object.hasOwn(edit.fields, field)) continue
    if (sameEditableValue(field, edit.fields[field], before?.fields[field])) {
      if (before?.fieldAuthors?.[field])
        fieldAuthors[field] = before.fieldAuthors[field]
    } else {
      fieldAuthors[field] = {
        by: edit.authorId,
        byName: edit.authorName ?? null,
        at: edit.updatedAt,
      }
    }
  }
  return { ...edit, fieldAuthors }
}

export function nextPlateEditVersions(
  previous: ReviewBatch,
  revision: number,
  touched: readonly string[]
) {
  if (!touched.length) return previous.plateEditVersions
  return {
    ...previous.plateEditVersions,
    ...Object.fromEntries(touched.map((id) => [id, revision])),
  }
}
