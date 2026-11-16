import { resumeHook } from 'workflow/api'
import { currentActor, publishAllowed, reviewDeps } from '../../../../../lib/server/context'
import { badRequest, json, readJson } from '../../../../../lib/server/respond'

export async function POST(request: Request, ctx: RouteContext<'/api/batches/[id]/publish'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  if (auth.actor.role !== 'owner') return json({ error: 'forbidden' }, 403)
  if (!publishAllowed()) return json({ error: 'publish_disabled_here' }, 403)

  const body = await readJson(request)
  if (typeof body?.revision !== 'number') return badRequest()

  const { id } = await ctx.params
  const batch = await reviewDeps().store.getBatch(id)
  if (!batch) return json({ error: 'not_found' }, 404)
  if (batch.state !== 'approved' || batch.revision !== body.revision) return json({ error: 'superseded_revision' }, 409)

  try {
    await resumeHook(`publish:${id}:${body.revision}`, { ownerUid: auth.actor.uid })
  } catch {
    return json({ error: 'not_waiting' }, 409)
  }
  return json({ status: 'publishing' }, 202)
}
