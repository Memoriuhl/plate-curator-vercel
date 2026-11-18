import { loadPlate } from '../../../../lib/catalog/dashboard'
import { currentActor } from '../../../../lib/server/context'
import { json } from '../../../../lib/server/respond'

/** Return authenticated plate detail for the workspace's cached detail view. */
export async function GET(
  request: Request,
  ctx: RouteContext<'/api/plates/[id]'>
) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const { id } = await ctx.params
  const detail = await loadPlate(id)
  if (!detail) return json({ error: 'not_found' }, 404)
  return Response.json(detail, {
    headers: { 'Cache-Control': 'private, max-age=60' },
  })
}
