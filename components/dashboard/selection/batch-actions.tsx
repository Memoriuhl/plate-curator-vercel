'use client'

import type { ReactNode } from 'react'
import { BatchLastChanged } from '@/components/review/batch-last-changed'
import {
  useWorkspaceBatch,
  useBatch,
  useMe,
  useSharedDraftId,
} from '@/lib/client/hooks'
import { PublishButton } from '../publish-button'
import { RunMenu } from '../run-menu'
import { TagRunBanner } from '../tagging/tag-run-banner'
import { useTagRun, type RunPlate } from '../tagging/use-tag-run'
import { useDashboardPipeline } from '../pipeline-runs/pipeline-runs'

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
  // Without a linked Batch, the Dashboard edits the shared draft.
  const draftId = useSharedDraftId()
  const personalDetail = useBatch(
    workspace.mode === 'personal' ? draftId : null,
    { reuse: true }
  )
  const batch =
    workspace.mode === 'selected'
      ? workspace.detail?.batch
      : personalDetail.data?.batch
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
          start={(plates, retry, modelId, stage, modelOptions) => {
            void run.start(
              plates,
              retry,
              modelId,
              stage,
              openPipeline,
              modelOptions
            )
          }}
        />
        <PublishButton
          batchId={
            workspace.mode === 'selected'
              ? workspace.id
              : (draftId ?? undefined)
          }
          owner={me.data?.role === 'owner'}
        />
        {workspace.mode === 'personal' && !batch && !detail.error ? (
          <span role="status">Loading the shared draft…</span>
        ) : null}
        {detail.error ? (
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
