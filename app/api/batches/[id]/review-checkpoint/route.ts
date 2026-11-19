import {
  batchTarget,
  draftWriteTarget,
} from '../../../../../lib/server/draft-target'
import { currentActiveOwner, reviewDeps } from '@/lib/server/context'
import { badRequest, json, readJson } from '@/lib/server/respond'

/**
 * Record the revision the owner has viewed after validating that it is current. Only the
 * shared draft keeps checkpoints: an old Batch or a release is read-only history.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/batches/[id]/review-checkpoint'>
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
  const { store, now } = reviewDeps()
  const marked = await store.markViewed?.(
    target.id,
    auth.actor.uid,
    body.revision,
    now()
  )
  return marked
    ? json({ revision: body.revision })
    : json({ error: 'superseded_revision' }, 409)
}

/**
 * Return current draft changes since a requested revision or the viewer's saved
 * checkpoint.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<'/api/batches/[id]/review-checkpoint'>
) {
  const auth = await currentActiveOwner(request)
  if (!auth.ok) return auth.response
  const raw = new URL(request.url).searchParams.get('since')
  if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    return badRequest()
  const id = await batchTarget((await ctx.params).id, auth.actor)
  const plateIds = await reviewDeps().store.recentPlateIds?.(id, Number(raw))
  return plateIds ? json({ plateIds }) : json({ error: 'not_found' }, 404)
}
