'use client'

import { Button } from '@/components/ui/button'
import type { PlateCardData } from '@/lib/catalog/dashboard-types'
import type { EditableFields, StandardChange } from '@/lib/review/types'
import type { EditResult } from '@/lib/client/hooks'

const errors = {
  standard_change_unconfirmed: 'Use Standard plate issues to make the first Template the Standard, then try again.',
  standard_required: 'Choose another Standard before changing this plate.',
  standard_invalid_template: 'The first plate must be a Template that is not deleted.',
  forbidden: "Only the batch's creator or an Owner can edit it.",
  superseded_revision: 'This batch has a newer revision. Reload and try again.',
  invalid_state: 'This batch is no longer open for editing.',
  not_found: 'This plate or batch could not be found.',
  stale_plate: 'Someone changed this while you were editing.',
}

export type Issue = {
  plate: PlateCardData
  fields: EditableFields
  standard?: StandardChange
  result: Extract<EditResult, { ok: false }>
}

/** Explain the reported edit conflict and offer the corresponding resolution actions. */
export function Conflict({
  issue,
  pending,
  onTheirs,
  onMine,
}: {
  issue: Issue
  pending: boolean
  onTheirs(): void
  onMine(): void
}) {
  if (issue.result.error !== 'stale_plate')
    return (
      <p role="alert" className="rounded-xl bg-[var(--danger-tint)] p-3">
        {issue.result.error === 'invalid_state' && issue.fields.deleted === true
          ? 'Cannot delete this plate. Set another Standard plate or move or detach its linked plates first.'
          : issue.result.error === 'invalid_state' && issue.fields.deleted === false
          ? "Undo the parent's deletion first."
          : errors[issue.result.error]}
      </p>
    )
  const result = issue.result
  return (
    <div
      role="alert"
      className="grid gap-3 rounded-xl border border-[var(--warning)] bg-[var(--warning-tint)] p-3 text-[var(--warning-ink)]"
    >
      <strong>Someone changed this while you were editing.</strong>
      {Object.keys(issue.fields).map((key) => {
        const field = key as keyof EditableFields
        return (
          <div key={key} className="grid gap-1 break-words sm:grid-cols-2">
            <span className="label sm:col-span-2">{key}</span>
            <p>Saved: {format(result.current[field])}</p>
            <p>Proposed: {format(result.draft[field])}</p>
          </div>
        )
      })}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={onTheirs}
        >
          Keep saved
        </Button>
        <Button size="sm" disabled={pending} onClick={onMine}>
          Reapply mine
        </Button>
      </div>
    </div>
  )
}

/** Format a field value for comparison, including empty and multi-value fields. */
function format(value: unknown) {
  if (value == null || value === '') return '(empty)'
  return Array.isArray(value) ? value.join(', ') : String(value)
}

