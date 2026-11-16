import { start } from 'workflow/api'
import { validateTagging } from '../../../../../../../lib/review/tagging'
import { currentActor, reviewDeps } from '../../../../../../../lib/server/context'
import { json, respond } from '../../../../../../../lib/server/respond'
import { taggingRun } from '../../../../../../../workflows/tagging'

export async function POST(request: Request, ctx: RouteContext<'/api/batches/[id]/plates/[plateId]/tagging'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const { id, plateId } = await ctx.params
  const validation = await validateTagging(reviewDeps(), auth.actor, id, plateId)
  if (!validation.ok) return respond(validation)

  const jobId = crypto.randomUUID()
  const run = await start(taggingRun, [jobId, id, plateId, auth.actor.uid])
  return json({ jobId, runId: run.runId }, 202)
}
