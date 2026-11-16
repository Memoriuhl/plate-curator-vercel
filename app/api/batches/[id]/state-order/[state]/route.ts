import { reorderState } from '../../../../../../lib/review/batch'
import { currentActor, reviewDeps } from '../../../../../../lib/server/context'
import { badRequest, readJson, respond } from '../../../../../../lib/server/respond'

export async function PUT(request: Request, ctx: RouteContext<'/api/batches/[id]/state-order/[state]'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const body = await readJson(request)
  if (typeof body?.batchRevision !== 'number' || !Number.isSafeInteger(body.batchRevision) || body.batchRevision < 0 ||
    !Array.isArray(body.order) || !body.order.every((id: unknown) => typeof id === 'string')) return badRequest()
  const { id, state } = await ctx.params
  return respond(await reorderState(reviewDeps(), auth.actor, {
    batchId: id, state, batchRevision: body.batchRevision, order: body.order,
  }))
}
