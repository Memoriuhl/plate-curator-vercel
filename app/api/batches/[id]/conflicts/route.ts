import { keepDraftValues } from '../../../../../lib/review/draft'
import { draftWriteTarget } from '../../../../../lib/server/draft-target'
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
  const target = await draftWriteTarget((await ctx.params).id, auth.actor)
  if (!target.ok) return target.response
  const id = target.id
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
