import { start } from 'workflow/api'
import { validateTagging } from '../../../../../../../lib/review/tagging'
import { currentActor, defaultTaggingModel, reviewDeps } from '../../../../../../../lib/server/context'
import { badRequest, json, readJson, respond } from '../../../../../../../lib/server/respond'
import { taggingModel } from '../../../../../../../lib/tagging/models'
import { hostedTaggingRun } from '../../../../../../../workflows/hosted-tagging'
import { taggingRun } from '../../../../../../../workflows/tagging'

export async function POST(request: Request, ctx: RouteContext<'/api/batches/[id]/plates/[plateId]/tagging'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const body = (await readJson(request)) ?? {}
  const choice = body.model === undefined ? defaultTaggingModel() : taggingModel(body.model)
  if (!choice) return badRequest()

  const { id, plateId } = await ctx.params
  const validation = await validateTagging(reviewDeps(), auth.actor, id, plateId)
  if (!validation.ok) return respond(validation)

  const jobId = crypto.randomUUID()
  const run = choice.runsOn === 'gateway'
    ? await start(hostedTaggingRun, [jobId, id, plateId, auth.actor.uid, choice.id])
    : await start(taggingRun, [jobId, id, plateId, auth.actor.uid, choice.id])
  return json({ jobId, runId: run.runId, model: choice.id }, 202)
}
