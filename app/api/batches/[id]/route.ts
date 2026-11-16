import { batchDetail } from '../../../../lib/review/queries'
import { currentActor, reviewDeps } from '../../../../lib/server/context'
import { respond } from '../../../../lib/server/respond'

export async function GET(request: Request, ctx: RouteContext<'/api/batches/[id]'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const { id } = await ctx.params
  return respond(await batchDetail(reviewDeps(), id))
}
