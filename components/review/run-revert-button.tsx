'use client'

import { useState } from 'react'
import { pipelineFieldLabel } from '@/components/dashboard/pipeline-field-value'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { ApiError, apiErrorReasons } from '@/lib/client/api'
import { useReviewActions } from '@/lib/client/hooks'
import type { RunRevertResult } from '@/lib/review/revert-run'

export function RunRevertButton({ runId }: { runId: string }) {
  const actions = useReviewActions()
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<RunRevertResult | null>(null)
  const [error, setError] = useState('')
  async function revert() {
    setPending(true)
    setError('')
    try {
      setResult(await actions.revertPipelineRun(runId))
    } catch (error) {
      setError(
        apiErrorReasons(error).join(' ') ||
          (error instanceof ApiError && error.code === 'pipeline_busy'
            ? 'Wait for this pipeline run to finish or cancel it before reverting its changes.'
            : 'Could not revert the run. Refresh and try again.')
      )
    } finally {
      setPending(false)
    }
  }

  const skipped = result?.skipped.length ?? 0
  return (
    <div className="grid justify-items-start gap-1">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button size="sm" variant="outline" disabled={pending || !!result}>
            {pending ? 'Reverting run…' : 'Revert pipeline run'}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert this pipeline run?</AlertDialogTitle>
            <AlertDialogDescription>
              Restore the previous values of the fields this run changed in the
              shared draft. Fields changed since then will be kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void revert()}>
              Revert run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error && (
        <p className="caption text-[var(--danger)]" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="caption" role="status">
          <p>
            {result.reverted} {result.reverted === 1 ? 'field' : 'fields'}{' '}
            reverted.
          </p>
          {skipped > 0 && (
            <details>
              <summary className="cursor-pointer">
                {skipped}{' '}
                {skipped === 1
                  ? 'field kept because it changed later'
                  : 'fields kept because they changed later'}
              </summary>
              <ul className="list-disc pl-5">
                {result.skipped.map(({ plateId, field }) => (
                  <li key={`${plateId}:${field}`}>
                    {plateId} · {pipelineFieldLabel(field)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
