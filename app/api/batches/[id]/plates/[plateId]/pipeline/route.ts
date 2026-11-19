import { batchTarget } from '../../../../../../../lib/server/draft-target'
import { start } from 'workflow/api'
import { validateTagging } from '@/lib/review/tagging'
import { chooseModel, currentActor, reviewDeps } from '@/lib/server/context'
import { badRequest, json, readJson, respond } from '@/lib/server/respond'
import { pipelineRun } from '@/workflows/pipeline'
import { localPipelineScope } from '@/lib/jobs/local-scope'
import { runnableLocalStage } from '@/lib/jobs/stages'

/** Validate a single-plate local stage request and start its pipeline job. */
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/batches/[id]/plates/[plateId]/pipeline'>
) {
  if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1')
    return json({ error: 'not_found' }, 404)
  try {
    if (!localPipelineScope()) return json({ error: 'not_found' }, 404)
  } catch {
    return json({ error: 'not_found' }, 404)
  }
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const body = await readJson(request)
  if (body?.previewOnly !== undefined && body.previewOnly !== false)
    return json(
      {
        error: 'unavailable',
        reason:
          'Standalone preview-only runs need the connected run coordinator',
      },
      422
    )
  const definition = runnableLocalStage(body?.stage)
  if (!body || !definition) return badRequest()
  const choice = definition.needsModel
    ? chooseModel(body.model, 'desktop')
    : null
  if (choice && !choice.ok)
    return choice.error === 'bad_request'
      ? badRequest()
      : respond({ ok: false, error: 'invalid_state' })
  const params = await ctx.params
  const plateId = params.plateId
  const id = await batchTarget(params.id, auth.actor)
  const validation = await validateTagging(
    reviewDeps(),
    auth.actor,
    id,
    plateId
  )
  if (!validation.ok) return respond(validation)
  const jobId = crypto.randomUUID()
  const modelId = choice?.ok ? choice.model.id : undefined
  const run = await start(pipelineRun, [
    jobId,
    id,
    plateId,
    auth.actor.uid,
    definition.stage,
    modelId,
  ])
  return json(
    {
      jobId,
      runId: run.runId,
      ...(modelId ? { model: modelId } : {}),
      stage: definition.stage,
    },
    202
  )
}
