import { start } from 'workflow/api'
import { validateTagging } from '../../../../../../../lib/review/tagging'
import { chooseModel, currentActor, reviewDeps } from '../../../../../../../lib/server/context'
import { badRequest, json, readJson, respond } from '../../../../../../../lib/server/respond'
import { hostedTaggingRun } from '../../../../../../../workflows/hosted-tagging'
import { taggingRun } from '../../../../../../../workflows/tagging'

/** Validate the plate and model selection before starting a hosted tagging run. */
export async function POST(request: Request, ctx: RouteContext<'/api/batches/[id]/plates/[plateId]/tagging'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const body = (await readJson(request)) ?? {}
  const choice = chooseModel(body.model)
  if (!choice.ok) return choice.error === 'bad_request' ? badRequest() : respond({ ok: false, error: 'invalid_state' })

  const { id, plateId } = await ctx.params
  const validation = await validateTagging(reviewDeps(), auth.actor, id, plateId)
  if (!validation.ok) return respond(validation)

  const jobId = crypto.randomUUID()
  const run = choice.model.runsOn === 'gateway'
    ? await start(hostedTaggingRun, [jobId, id, plateId, auth.actor.uid, choice.model.id])
    : await start(taggingRun, [jobId, id, plateId, auth.actor.uid, choice.model.id])
  return json({ jobId, runId: run.runId, model: choice.model.id }, 202)
}
