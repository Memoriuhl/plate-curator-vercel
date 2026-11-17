import type { PublishRequester } from '../lib/publish/types'
import { createHook, RetryableError, sleep } from 'workflow'
import { publishBatch } from '../lib/publish/publish'
import { catalogChanged } from '../lib/server/catalog-head'
import { publishDeps, reviewDeps } from '../lib/server/context'
import { catalogPush } from './catalog-push'

export async function approvalRun(batchId: string, revision: number) {
  'use workflow'

  const decision = createHook<{ by: string } | { superseded: true }>({ token: `approval:${batchId}:${revision}` })
  const before = await readBatch(batchId)
  if (before?.state === 'submitted' && before.revision === revision) {
    const decided = await Promise.race([decision, sleep('7d').then(() => 'timeout' as const)])
    if (decided === 'timeout') return { outcome: 'decision_timeout' as const }
    if ('superseded' in decided) return { outcome: 'superseded' as const }
  }

  const approved = await readBatch(batchId)
  if (approved?.state !== 'approved' || approved.approval?.revision !== revision) return { outcome: 'superseded' as const }

  const command = createHook<PublishRequester | { superseded: true }>({ token: `publish:${batchId}:${approved.revision}` })
  const current = await readBatch(batchId)
  if (current?.state !== 'approved' || current.revision !== approved.revision) return { outcome: 'superseded' as const }
  const requested = await Promise.race([command, sleep('7d').then(() => 'timeout' as const)])
  if (requested === 'timeout') return { outcome: 'publish_timeout' as const }
  if ('superseded' in requested) return { outcome: 'superseded' as const }

  const outcome = await runPublish(batchId, approved.revision, requested)
  if (outcome.outcome === 'published') return { ...outcome, push: await catalogPush(outcome.version) }
  return outcome
}

async function readBatch(batchId: string) {
  'use step'
  return reviewDeps().store.getBatch(batchId)
}

async function runPublish(batchId: string, revision: number, command: PublishRequester) {
  'use step'
  const batch = await reviewDeps().store.getBatch(batchId)
  if (!batch || (batch.state !== 'published' && (batch.state !== 'approved' || batch.revision !== revision || batch.approval?.revision !== revision - 1))) return { outcome: 'superseded' as const }
  const { ownerUid, ...authority } = command
  const outcome = await publishBatch(publishDeps(), { uid: ownerUid, name: null, role: 'owner' }, { batchId, revision, ...authority })
  if (outcome.ok) catalogChanged()
  if (!outcome.ok && (outcome.error === 'locked' || outcome.error === 'unavailable')) {
    throw new RetryableError(`Publish ${outcome.error}`, { retryAfter: '30s' })
  }
  return outcome.ok
    ? { outcome: 'published' as const, version: outcome.value.toVersion, ...(command.requestedBy ? { requestedBy: command.requestedBy } : {}) }
    : { outcome: 'publish_failed' as const, error: outcome.error, reasons: outcome.reasons ?? [], ...(command.requestedBy ? { requestedBy: command.requestedBy } : {}), ...(outcome.reviewedVersion !== undefined ? { reviewedVersion: outcome.reviewedVersion, liveVersion: outcome.liveVersion } : {}) }
}
