'use client'

import type { ReactNode } from 'react'
import { BatchLastChanged } from '@/components/review/batch-last-changed'
import { mostRecentBatch } from '@/lib/review/batch-selection'
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
import { useDashboardPipeline } from './pipeline-runs'

/** Show batch and model actions for the active jurisdiction or plate selection. */
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
  const batches = useBatches(['open'], { mine: true })
  const personalBatch = mostRecentBatch(batches.data)
  const batch =
    workspace.mode === 'selected' ? workspace.detail?.batch : personalBatch
  const personalDetail = useBatch(
    workspace.mode === 'personal' ? (batch?.id ?? null) : null,
    { reuse: true }
  )
  const detail =
    workspace.mode === 'selected'
      ? {
          data: workspace.detail,
          isLoading: workspace.status === 'loading',
          error: workspace.status === 'unavailable',
        }
      : personalDetail
  const me = useMe()
  const run = useTagRun()
  const { queue, openPipeline } = useDashboardPipeline()
  const batchPlates =
    detail.data?.plates.map(({ proposed, revision }) => {
      const {
        id,
        state,
        displayName,
        tags,
        description,
        wikiUrl,
        funFacts,
        firstIssuedYear,
        readMore,
      } = proposed
      return {
        id,
        state,
        displayName,
        revision,
        tags,
        hasStory: Array.isArray(funFacts) && funFacts.length > 0,
        description,
        wikiUrl,
        funFacts,
        firstIssuedYear,
        readMore,
      }
    }) ?? []
  return (
    <header className="state-header">
      {children}
      <div className="batch-actions" aria-label={`${stateCode} batch actions`}>
        {workspace.mode === 'personal' && batch ? (
          <span className="batch-summary min-w-0 flex-wrap">
            <Avatar size="sm">
              <AvatarFallback>
                {(batch.createdByName || batch.createdBy)
                  .slice(0, 1)
                  .toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <strong>{batch.name}</strong>
            <BatchLastChanged batch={detail.data?.batch ?? batch} />
          </span>
        ) : null}
        <RunMenu
          queue={queue}
          underTagged={underTagged}
          allPlates={allPlates}
          batchPlates={batchPlates}
          stateName={stateName}
          disabledReason={run.disabledReason}
          disabled={
            !!run.disabledReason || run.entries.length > 0 || run.starting
          }
          modelError={run.modelError}
          start={(plates, retry, modelId, stage) => {
            void run.start(plates, retry, modelId, stage, (runId) =>
              openPipeline(runId)
            )
          }}
        />
        <PublishButton
          batchId={workspace.mode === 'selected' ? workspace.id : batch?.id}
          owner={me.data?.role === 'owner'}
        />
        {workspace.mode === 'personal' && batches.isLoading && !batch ? (
          <span role="status">Loading your Batch…</span>
        ) : null}
        {workspace.mode === 'personal' &&
        !batches.isLoading &&
        !batches.error &&
        !batch ? (
          <span>No open Batch yet</span>
        ) : null}
        {(workspace.mode === 'personal' && batches.error) || detail.error ? (
          <span role="alert">Could not load this Batch.</span>
        ) : null}
      </div>
      <TagRunBanner
        entries={run.entries}
        starting={run.starting}
        batchId={run.batchId}
        dismiss={run.dismiss}
        retry={(plate) => void run.start([plate], true)}
      />
    </header>
  )
}
