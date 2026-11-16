import { createHook, RetryableError, sleep } from 'workflow'
import { publishBatch } from '../lib/publish/publish'
import { publishDeps, reviewDeps } from '../lib/server/context'

export async function approvalRun(batchId: string, revision: number) {
  'use workflow'

  const decision = createHook<{ by: string }>({ token: `approval:${batchId}:${revision}` })
  const before = await readBatch(batchId)
  if (before?.state === 'submitted' && before.revision === revision) {
    const decided = await Promise.race([decision, sleep('7d').then(() => 'timeout' as const)])
    if (decided === 'timeout') return { outcome: 'decision_timeout' as const }
  }

  const approved = await readBatch(batchId)
  if (approved?.state !== 'approved' || approved.approval?.revision !== revision) return { outcome: 'superseded' as const }

  const command = createHook<{ ownerUid: string }>({ token: `publish:${batchId}:${approved.revision}` })
  const requested = await Promise.race([command, sleep('7d').then(() => 'timeout' as const)])
  if (requested === 'timeout') return { outcome: 'publish_timeout' as const }

  return runPublish(batchId, approved.revision, requested.ownerUid)
}

async function readBatch(batchId: string) {
  'use step'
  return reviewDeps().store.getBatch(batchId)
}

async function runPublish(batchId: string, revision: number, ownerUid: string) {
  'use step'
  const outcome = await publishBatch(publishDeps(), { uid: ownerUid, role: 'owner' }, { batchId, revision })
  if (!outcome.ok && (outcome.error === 'locked' || outcome.error === 'unavailable')) {
    throw new RetryableError(`Publish ${outcome.error}`, { retryAfter: '30s' })
  }
  return outcome.ok
    ? { outcome: 'published' as const, version: outcome.value.toVersion }
    : { outcome: 'publish_failed' as const, error: outcome.error, reasons: outcome.reasons ?? [] }
}
