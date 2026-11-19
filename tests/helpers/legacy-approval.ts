import { canEdit, reviewApprovalProblems } from '../../lib/review/batches/batch'
import type {
  Actor,
  Outcome,
  ReviewBatch,
  ReviewDeps,
} from '../../lib/review/types'

/**
 * Move a Batch into the states Submit and Approve used to produce. The app no longer
 * offers either step; publish fixtures still need an approved Batch, which is what the
 * Owner publish path now creates for each release.
 */
async function transition(
  d: ReviewDeps,
  actor: Actor,
  batchId: string,
  revision: number,
  state: 'submitted' | 'approved'
): Promise<Outcome<ReviewBatch>> {
  const batch = await d.store.getBatch(batchId)
  if (!batch) return { ok: false, error: 'not_found' }
  if (state === 'approved' && actor.role !== 'owner')
    return { ok: false, error: 'forbidden' }
  if (!canEdit(batch, actor)) return { ok: false, error: 'forbidden' }
  if (batch.revision !== revision)
    return { ok: false, error: 'superseded_revision' }
  if (batch.state !== (state === 'submitted' ? 'open' : 'submitted'))
    return { ok: false, error: 'invalid_state' }
  const reasons = await reviewApprovalProblems(d, batch)
  if (reasons.length)
    return { ok: false, error: 'standard_change_unconfirmed', reasons }
  const next: ReviewBatch = {
    ...batch,
    ...(state === 'submitted'
      ? { publishRequestedAt: null, publishRequestedBy: null }
      : {}),
    state,
    revision: revision + 1,
    approval:
      state === 'approved' ? { revision, by: actor.uid, at: d.now() } : null,
  }
  const result = await d.store.commit(batchId, revision, { batch: next })
  return result === 'ok'
    ? { ok: true, value: next }
    : { ok: false, error: 'superseded_revision' }
}

export const submitBatch = (
  d: ReviewDeps,
  actor: Actor,
  batchId: string,
  revision: number
) => transition(d, actor, batchId, revision, 'submitted')

export const approveBatch = (
  d: ReviewDeps,
  actor: Actor,
  batchId: string,
  revision: number
) => transition(d, actor, batchId, revision, 'approved')
