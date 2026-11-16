import { resumeHook } from 'workflow/api'
import { approveBatch } from '../../../../../lib/review/batch'
import { currentActor, reviewDeps } from '../../../../../lib/server/context'
import { badRequest, readJson, respond } from '../../../../../lib/server/respond'

export async function POST(request: Request, ctx: RouteContext<'/api/batches/[id]/approve'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const body = await readJson(request)
  if (typeof body?.revision !== 'number') return badRequest()

  const { id } = await ctx.params
  const outcome = await approveBatch(reviewDeps(), auth.actor, id, body.revision)
  if (outcome.ok) await resumeHook(`approval:${id}:${body.revision}`, { by: auth.actor.uid }).catch(() => undefined)
  return respond(outcome)
}
