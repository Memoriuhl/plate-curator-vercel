import { ensureDraft } from '../review/draft'
import { isSharedDraftId } from '../review/draft-id'
import type { Actor } from '../review/types'
import { reviewDeps, reviewEnv } from './context'

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
