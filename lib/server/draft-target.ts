import { ensureDraft } from '../review/draft'
import { isSharedDraft, isSharedDraftId } from '../review/draft-id'
import type { Actor } from '../review/types'
import { reviewDeps, reviewEnv } from './context'
import { json } from './respond'

/**
 * Resolve the batch a request names. The `draft` alias (or the draft's own id) becomes
 * this environment's shared draft, created on first use and moved onto the live catalog
 * version if a publish moved it. Any other id is a release or an old Batch, which the
 * review rules treat as read-only history.
 */
export async function batchTarget(
  id: string,
  actor: Pick<Actor, 'uid' | 'name'>
): Promise<string> {
  return isSharedDraftId(id)
    ? (await ensureDraft(reviewDeps(), reviewEnv(), actor)).id
    : id
}

export type WriteTarget =
  { ok: true; id: string } | { ok: false; response: Response }

/** Body for a curator write sent to an old Batch or a release. */
export const historyReadOnly = {
  error: 'history_read_only',
  message:
    'Old Batches and releases are read-only history. Make the change in the shared draft.',
}

/**
 * Resolve the batch a curator write names. Only the shared draft takes curator writes:
 * an old Batch or a release answers 409 with `history_read_only`, so a tab left open
 * from before the cutover cannot save into a Batch nobody reviews or publishes. Publish
 * recovery on a release has its own routes.
 */
export async function draftWriteTarget(
  id: string,
  actor: Pick<Actor, 'uid' | 'name'>
): Promise<WriteTarget> {
  if (isSharedDraftId(id)) return { ok: true, id: await batchTarget(id, actor) }
  const batch = await reviewDeps().store.getBatch(id)
  if (isSharedDraft(batch)) return { ok: true, id }
  return {
    ok: false,
    response: batch
      ? json(historyReadOnly, 409)
      : json({ error: 'not_found' }, 404),
  }
}
