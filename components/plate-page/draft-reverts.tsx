'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { pipelineFieldLabel } from '@/components/dashboard/pipeline-field-value'
import { FieldAttribution } from '@/components/review/field-attribution'
import { Button } from '@/components/ui/button'
import { ApiError, apiErrorReasons } from '@/lib/client/api'
import {
  useBatch,
  useReviewActions,
  useSharedDraftId,
} from '@/lib/client/hooks'
import { isSharedDraftId } from '@/lib/review/draft-id'
import { editableKeys } from '@/lib/review/fields'
import { sameEditableValue } from '@/lib/review/story'
import type { DraftChangeTarget } from '@/lib/review/types'

export function PlateDraftReverts({
  plateId,
  disabled,
  onReverted,
}: {
  plateId: string
  disabled: boolean
  onReverted: (target: DraftChangeTarget) => void
}) {
  const selected = useSearchParams().get('batch')
  const shared = useSharedDraftId()
  const id = selected && !isSharedDraftId(selected) ? null : shared
  const { data } = useBatch(id, { reuse: true })
  const actions = useReviewActions()
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<{
    message: string
    error: boolean
  } | null>(null)
  const entry = data?.plates.find((item) => item.baseline.id === plateId)
  const fields = entry
    ? editableKeys.filter(
        (field) =>
          !sameEditableValue(
            field,
            entry.baseline[field],
            entry.proposed[field]
          ) &&
          (!['isStandard', 'deleted'].includes(field) ||
            Boolean(entry.baseline[field]) !== Boolean(entry.proposed[field]))
      )
    : []

  async function revert(target: DraftChangeTarget) {
    if (!data || pending || disabled) return
    setPending(true)
    setFeedback(null)
    try {
      await actions.discardPlateChanges(
        data.batch.id,
        plateId,
        data.batch.revision,
        target
      )
      onReverted(target)
      setFeedback({ message: 'Reverted to the catalog.', error: false })
    } catch (error) {
      setFeedback({
        error: true,
        message:
          apiErrorReasons(error).join(' ') ||
          (error instanceof ApiError && error.code === 'superseded_revision'
            ? 'The draft changed. Check the latest values before reverting.'
            : 'Could not revert the change. Try again.'),
      })
    } finally {
      setPending(false)
    }
  }

  if (!id) return null
  return (
    <>
      {(fields.length > 0 || entry?.order) && (
        <details className="rounded-[var(--radius-lg)] bg-[var(--card)] px-4 py-2">
          <summary className="caption cursor-pointer font-semibold">
            Revert draft changes
          </summary>
          <div className="flex flex-wrap gap-x-4 gap-y-2 pt-2">
            {fields.map((field) => {
              const attribution = entry?.edit?.pipelineChanges?.[field]
              return (
                <div key={field} className="grid justify-items-start gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled || pending}
                    onClick={() => void revert(field)}
                  >
                    Revert {pipelineFieldLabel(field).toLowerCase()}
                  </Button>
                  {attribution && <FieldAttribution change={attribution} />}
                </div>
              )
            })}
            {entry?.order && (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || pending}
                onClick={() => void revert('order')}
              >
                Revert position
              </Button>
            )}
          </div>
        </details>
      )}
      {feedback && (
        <p
          className={
            feedback.error ? 'caption text-[var(--danger)]' : 'caption'
          }
          role={feedback.error ? 'alert' : 'status'}
        >
          {feedback.message}
        </p>
      )}
    </>
  )
}
