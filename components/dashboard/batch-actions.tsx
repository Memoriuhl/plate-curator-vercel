'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { BatchLastChanged } from '@/components/review/batch-last-changed'
import { mostRecentBatch } from '@/lib/review/batch-selection'
import { batchHref, reviewHref } from '@/lib/review/href'
import {
  useWorkspaceBatch,
  useBatch,
  useBatches,
  useMe,
} from '@/lib/client/hooks'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
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
  const personalBatch = mostRecentBatch(batches.data)
  const batch = workspace.mode === 'selected' ? workspace.detail?.batch : personalBatch
  const personalDetail = useBatch(workspace.mode === 'personal' ? batch?.id ?? null : null, { reuse: true })
  const detail = workspace.mode === 'selected' ? { data: workspace.detail, isLoading: workspace.status === 'loading', error: workspace.status === 'unavailable' } : personalDetail
  const me = useMe()
  const run = useTagRun()
  const queue = usePipelineQueue(batch?.id, batch?.name)
  const batchPlates =
    detail.data?.plates
      .map((entry) => ({ ...entry.proposed, revision: entry.revision }))
      .map(({ id, state, displayName, revision, tags, funFacts }) => ({
        id,
        state,
        displayName,
        revision,
        tags,
        hasStory: Array.isArray(funFacts) && funFacts.length > 0,
      })) ?? []
  return (
    <>
      <PipelineRuns queue={queue} />
      <header className="state-header">
        {children}
        <div className="batch-actions" aria-label={`${stateCode} batch actions`}>
          {workspace.mode === 'personal' && batch ? (
            <span className="batch-summary min-w-0 flex-wrap">
              <Avatar size="sm">
                <AvatarFallback>{(batch.createdByName || batch.createdBy).slice(0, 1).toUpperCase()}</AvatarFallback>
              </Avatar>
              <strong>{batch.name}</strong>
              <BatchLastChanged batch={detail.data?.batch ?? batch} />
            </span>
          ) : null}
          {workspace.mode === 'personal' && batch ? <Link href={batchHref(pathname, batch.id)}>Open / Share</Link> : null}
          {batch ? <Link href={reviewHref(undefined, undefined, batch.id)}>Review Batch</Link> : null}
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
          <PublishButton batchId={workspace.mode === 'selected' ? workspace.id : batch?.id} owner={me.data?.role === 'owner'} />
          {workspace.mode === 'personal' && batches.isLoading && !batch ? <span role="status">Loading your Batch…</span> : null}
          {workspace.mode === 'personal' && !batches.isLoading && !batches.error && !batch ? <span>No open Batch yet</span> : null}
          {(workspace.mode === 'personal' && batches.error) || detail.error ? <span role="alert">Could not load this Batch.</span> : null}
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
