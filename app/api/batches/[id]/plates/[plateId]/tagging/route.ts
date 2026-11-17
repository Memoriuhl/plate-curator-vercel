import { start } from 'workflow/api'
import { validateTagging } from '../../../../../../../lib/review/tagging'
import { currentActor, reviewDeps, taggingBackend } from '../../../../../../../lib/server/context'
import { json, respond } from '../../../../../../../lib/server/respond'
import { hostedTaggingRun } from '../../../../../../../workflows/hosted-tagging'
import { taggingRun } from '../../../../../../../workflows/tagging'

export async function POST(request: Request, ctx: RouteContext<'/api/batches/[id]/plates/[plateId]/tagging'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const { id, plateId } = await ctx.params
  const validation = await validateTagging(reviewDeps(), auth.actor, id, plateId)
  if (!validation.ok) return respond(validation)

  const jobId = crypto.randomUUID()
  const args = [jobId, id, plateId, auth.actor.uid] as const
  const run = taggingBackend() === 'hosted' ? await start(hostedTaggingRun, [...args]) : await start(taggingRun, [...args])
  return json({ jobId, runId: run.runId }, 202)
}
