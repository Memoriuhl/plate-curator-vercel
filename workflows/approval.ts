import { requesterFields } from '../lib/publish/authority'
import type { PublishRequester } from '../lib/publish/types'
import { RetryableError } from 'workflow'
import { publishBatch } from '../lib/publish/publish'
import { catalogChanged } from '../lib/server/catalog-head'
import { publishDeps, reviewDeps } from '../lib/server/context'
import { catalogPush } from './catalog-push'
import { afterPublish } from '../lib/review/draft'

/** Run a confirmed publish command and send catalog notifications if it commits. */
export async function publishRun(
  batchId: string,
  revision: number,
  command: PublishRequester
) {
  'use workflow'
  const outcome = await runPublish(batchId, revision, command)
  if (outcome.outcome !== 'published') return outcome
  const rebased = await rebaseSharedDraft(batchId, outcome.version)
  return { ...outcome, rebased, push: await catalogPush(outcome.version) }
}

/**
 * Move the shared draft onto the version a release just published, keeping edits made
 * after the published revision. A failure here never fails the publish: the next draft
 * read rebases it lazily.
 */
async function rebaseSharedDraft(batchId: string, version: number) {
  'use step'
  try {
    const outcome = await afterPublish(reviewDeps(), batchId, version)
    return outcome.ok || outcome.error === 'not_found'
  } catch {
    return false
  }
}

/**
 * Execute the release in a step and invalidate catalog caches when the live version
 * changes.
 */
async function runPublish(
  batchId: string,
  revision: number,
  command: PublishRequester
) {
  'use step'
  const batch = await reviewDeps().store.getBatch(batchId)
  if (
    !batch ||
    (batch.state !== 'published' &&
      (batch.state !== 'approved' ||
        batch.revision !== revision ||
        batch.approval?.revision !== revision - 1))
  )
    return { outcome: 'superseded' as const }
  const { ownerUid, ...authority } = command
  const outcome = await publishBatch(
    publishDeps(),
    { uid: ownerUid, name: null, role: 'owner' },
    { batchId, revision, ...authority }
  )
  // Expire the catalog head after the release so server reads see the new version.
  if (outcome.ok) catalogChanged()
  if (
    !outcome.ok &&
    (outcome.error === 'locked' || outcome.error === 'unavailable')
  ) {
    throw new RetryableError(`Publish ${outcome.error}`, { retryAfter: '30s' })
  }
  return outcome.ok
    ? {
        outcome: 'published' as const,
        version: outcome.value.toVersion,
        ...requesterFields(command.requestedBy),
      }
    : {
        outcome: 'publish_failed' as const,
        error: outcome.error,
        reasons: outcome.reasons ?? [],
        ...requesterFields(command.requestedBy),
        ...(outcome.reviewedVersion !== undefined
          ? {
              reviewedVersion: outcome.reviewedVersion,
              liveVersion: outcome.liveVersion,
            }
          : {}),
      }
}
