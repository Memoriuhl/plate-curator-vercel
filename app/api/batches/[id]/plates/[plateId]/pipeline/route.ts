import { start } from 'workflow/api'
import { validateTagging } from '@/lib/review/tagging'
import { chooseModel, currentActor, reviewDeps } from '@/lib/server/context'
import { badRequest, json, readJson, respond } from '@/lib/server/respond'
import { pipelineRun } from '@/workflows/pipeline'
import { localPipelineScope } from '@/lib/jobs/local-scope'

export async function POST(request: Request, ctx: RouteContext<'/api/batches/[id]/plates/[plateId]/pipeline'>) {
  if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1') return json({ error: 'not_found' }, 404)
  try { if (!localPipelineScope()) return json({ error: 'not_found' }, 404) } catch { return json({ error: 'not_found' }, 404) }
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const body = await readJson(request)
  if (!body || body.stage !== 'describe' && body.stage !== 'story') return badRequest()
  const choice = chooseModel(body.model, 'desktop')
  if (!choice.ok) return choice.error === 'bad_request' ? badRequest() : respond({ ok: false, error: 'invalid_state' })
  const { id, plateId } = await ctx.params
  const validation = await validateTagging(reviewDeps(), auth.actor, id, plateId)
  if (!validation.ok) return respond(validation)
  const jobId = crypto.randomUUID()
  const run = await start(pipelineRun, [jobId, id, plateId, auth.actor.uid, body.stage, choice.model.id])
  return json({ jobId, runId: run.runId, model: choice.model.id, stage: body.stage }, 202)
}
