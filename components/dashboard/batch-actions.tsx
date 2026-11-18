'use client'

import Link from 'next/link'
import { ApiError, apiErrorReasons } from '@/lib/client/api'
import { usePathname } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { IoPaperPlaneOutline } from 'react-icons/io5'
import {
  useWorkspaceBatch,
  useBatch,
  useBatches,
  useMe,
  useReviewActions,
} from '@/lib/client/hooks'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { PublishButton } from './publish-button'
import { RunMenu } from './run-menu'
import { TagRunBanner } from './tag-run-banner'
import { useTagRun, type RunPlate } from './use-tag-run'
import { usePipelineQueue } from './use-pipeline-queue'
import { PipelineRuns } from './pipeline-runs'

export function BatchActions({
  underTagged,
  allPlates,
  stateCode,
  stateName,
  children,
}: {
  underTagged: RunPlate[]
  allPlates?: RunPlate[]
  stateCode: string
  stateName: string
  children?: ReactNode
}) {
  const workspace = useWorkspaceBatch()
  const pathname = usePathname()
  const batches = useBatches(['open'], { mine: true })
  const personalBatch = batches.data?.toSorted((a, b) =>
    (
      (b as typeof b & { updatedAt?: string }).updatedAt ?? b.createdAt
    ).localeCompare(
      (a as typeof a & { updatedAt?: string }).updatedAt ?? a.createdAt,
    ),
  )[0]
  const batch = workspace.mode === 'selected' ? workspace.detail?.batch : personalBatch
  const personalDetail = useBatch(workspace.mode === 'personal' ? batch?.id ?? null : null, { reuse: true })
  const detail = workspace.mode === 'selected' ? { data: workspace.detail, isLoading: workspace.status === 'loading', error: workspace.status === 'unavailable' } : personalDetail
  const me = useMe()
  const actions = useReviewActions()
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const run = useTagRun()
  const queue = usePipelineQueue(batch?.id, batch?.name)
  const batchPlates =
    detail.data?.plates.map(({ proposed, revision }) => {
      const { id, state, displayName, tags, description, wikiUrl, funFacts, firstIssuedYear, readMore } = proposed
      return {
        id,
        state,
        displayName,
        revision,
        tags,
        hasStory: Array.isArray(funFacts) && funFacts.length > 0,
        description, wikiUrl, funFacts, firstIssuedYear, readMore,
      }
    }) ?? []
  const edits =
    detail.data?.plates.filter((plate) => plate.order !== undefined || plate.edit && Object.keys(plate.edit.fields).length > 0).length ?? 0
  const pipelineBusy = queue.runs.some(run => run.batchId === batch?.id && run.incrementalDrafts && ['queued', 'running'].includes(run.status))
  return (
    <>
      <PipelineRuns queue={queue} />
      <header className="state-header">
        {children}
        <div className="batch-actions" aria-label={`${stateCode} batch actions`}>
          <span className="batch-summary min-h-6 min-w-60" aria-hidden={!batch}>
            {batch ? (
              <>
                <Avatar size="sm">
                  <AvatarFallback>
                    {(me.data?.uid ?? batch.createdBy).slice(0, 1).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span>
                  {workspace.mode === 'selected' ? 'Selected batch:' : 'Your batch:'}{' '}
                  {detail.isLoading ? 'Loading…' : `${edits} changes, saved`}
                </span>
                {workspace.mode === 'selected' ? <span>{batch.state}</span> : null}
              </>
            ) : null}
          </span>
          {workspace.mode === 'personal' && batch ? <Link href={pathname + '?batch=' + encodeURIComponent(batch.id)}>Open / Share</Link> : null}
          <Button
            variant="outline"
            disabled={
              (workspace.mode === 'selected' && workspace.status !== 'ready') || !batch || batch.state !== 'open' || !detail.data || !!detail.error || !edits || pending || pipelineBusy
            }
            title={pipelineBusy ? 'Wait for this Batch’s pipeline work to finish.' : undefined}
            onClick={async () => {
              if (!detail.data || (workspace.mode === 'selected' && workspace.status !== 'ready')) return
              setPending(true)
              setMessage('')
              try {
                await actions.submit(
                  detail.data.batch.id,
                  detail.data.batch.revision,
                )
                setMessage('Submitted for review.')
              } catch (error) {
                const code = error instanceof ApiError ? error.code : null
                if (code === 'standard_change_unconfirmed') setMessage(apiErrorReasons(error).join(' ') || 'Use Standard plate issues to make the first Template the Standard, then submit again.')
                else if (code === 'pipeline_busy') setMessage('Submit after the Plate Pipeline finishes this Batch.')
                else setMessage('Could not submit your batch. Please try again.')
              } finally {
                setPending(false)
              }
            }}
          >
            <IoPaperPlaneOutline aria-hidden="true" />
            {pending ? 'Submitting…' : 'Submit for review'}
          </Button>
          <RunMenu
            queue={queue}
            underTagged={underTagged}
            allPlates={allPlates}
            batchPlates={batchPlates}
            stateName={stateName}
            disabledReason={run.disabledReason}
            disabled={!!run.disabledReason || run.entries.length > 0 || run.starting}
            modelError={run.modelError}
            start={(plates, retry, modelId, stage) => void run.start(plates, retry, modelId, stage)}
          />
          <PublishButton batchId={batch?.id} owner={me.data?.role === 'owner'} draft={edits > 0 && (batch?.state === 'open' || batch?.state === 'submitted')} approved={batch?.state === 'approved'} />
          {batches.error || detail.error ? (
            <span role="alert">Could not load your batch.</span>
          ) : null}
          {message ? <span role="status">{message}</span> : null}
        </div>
        <TagRunBanner
          entries={run.entries}
          starting={run.starting}
          batchId={run.batchId}
          dismiss={run.dismiss}
          retry={(plate) => void run.start([plate], true)}
        />
      </header>
    </>
  )
}
