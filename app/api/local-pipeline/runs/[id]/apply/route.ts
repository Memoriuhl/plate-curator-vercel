import { applyQueueBundle } from '../../../../../../lib/jobs/queue-bundle'
import { currentActor, jobsDeps, reviewDeps } from '../../../../../../lib/server/context'
import { respond } from '../../../../../../lib/server/respond'

/**
 * Apply the selected completed preview run to a batch after checking the actor's access.
 */
export async function POST(request: Request, ctx: RouteContext<'/api/local-pipeline/runs/[id]/apply'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  return respond(await applyQueueBundle(jobsDeps(), reviewDeps(), auth.actor, (await ctx.params).id))
}
