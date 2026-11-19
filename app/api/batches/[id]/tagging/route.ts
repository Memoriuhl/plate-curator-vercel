import { chooseRunTaggingModel } from '../../../../../lib/jobs/model-binding'
import { draftWriteTarget } from '../../../../../lib/server/draft-target'
import { start } from 'workflow/api'
import { canEdit } from '../../../../../lib/review/batches/batch'
import { currentActor, reviewDeps } from '../../../../../lib/server/context'
import {
  badRequest,
  json,
  readJson,
  respond,
} from '../../../../../lib/server/respond'
import { batchTaggingRun } from '../../../../../workflows/hosted-tagging'

const MAX_BATCH_TAGGING = 500

/**
 * Authorize a batch tagging request and start a hosted run for the selected plates and
 * model.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/batches/[id]/tagging'>
) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  if (auth.actor.role !== 'owner') return json({ error: 'forbidden' }, 403)

  const target = await draftWriteTarget((await ctx.params).id, auth.actor)
  if (!target.ok) return target.response
  const id = target.id
  const body = await readJson(request)
  if (!body) return badRequest()
  const choice = await chooseRunTaggingModel(
    body.model,
    body.modelOptions,
    auth.actor.role === 'owner',
    'gateway'
  )
  if (!choice.ok)
    return choice.error === 'bad_request'
      ? badRequest()
      : json({ error: 'unavailable' }, 422)
  const requested = body.plateIds
  if (
    requested !== undefined &&
    (!Array.isArray(requested) ||
      !requested.every((value) => typeof value === 'string'))
  )
    return badRequest()

  const deps = reviewDeps()
  const batch = await deps.store.getBatch(id)
  if (!batch) return respond({ ok: false, error: 'not_found' })
  if (!canEdit(batch, auth.actor))
    return respond({ ok: false, error: 'forbidden' })
  if (batch.state !== 'open')
    return respond({ ok: false, error: 'invalid_state' })

  const plateIds = [
    ...new Set((requested as string[] | undefined) ?? batch.plateIds),
  ]
  if (plateIds.length === 0 || plateIds.length > MAX_BATCH_TAGGING)
    return badRequest()
  const members = new Set(batch.plateIds)
  if (!plateIds.every((plateId) => members.has(plateId)))
    return respond({ ok: false, error: 'not_found' })

  const requests = plateIds.map((plateId) => ({
    jobId: crypto.randomUUID(),
    plateId,
  }))
  const run = await start(batchTaggingRun, [
    id,
    requests,
    auth.actor.uid,
    choice.model.id,
    choice.binding,
  ])
  return json({ runId: run.runId, model: choice.model.id, jobs: requests }, 202)
}
