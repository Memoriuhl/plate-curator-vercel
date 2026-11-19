import { isSharedDraftId } from '../../../../../lib/review/draft-id'
import { keepDraftValues } from '../../../../../lib/review/draft'
import { batchTarget } from '../../../../../lib/server/draft-target'
import { currentActiveOwner, reviewDeps } from '@/lib/server/context'
import { badRequest, json, readJson } from '@/lib/server/respond'

/**
 * The Owner keeps the shared draft's pending values over the outside catalog changes
 * recorded as conflicts, for the revision they were shown, so Publish can go ahead.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/batches/[id]/conflicts'>
) {
  const auth = await currentActiveOwner(request)
  if (!auth.ok) return auth.response
  const body = await readJson(request)
  if (
    typeof body?.revision !== 'number' ||
    !Number.isSafeInteger(body.revision) ||
    body.revision < 0
  )
    return badRequest()
  const { id: raw } = await ctx.params
  if (!isSharedDraftId(raw)) return json({ error: 'not_found' }, 404)
  const id = await batchTarget(raw, auth.actor)
  const kept = await keepDraftValues(reviewDeps(), auth.actor, {
    batchId: id,
    revision: body.revision,
  })
  if (kept.ok) return json({ revision: kept.value.revision })
  return json(
    { error: kept.error },
    kept.error === 'not_found' ? 404 : kept.error === 'forbidden' ? 403 : 409
  )
}
