import { batchTarget } from '../../../../../lib/server/draft-target'
import { createJob } from '@/lib/jobs/jobs'
import { prepareGroupScope } from '@/lib/review/group'
import {
  chooseModel,
  currentActor,
  jobsDeps,
  reviewDeps,
} from '@/lib/server/context'
import { badRequest, json, readJson, respond } from '@/lib/server/respond'
import type { ImageGroupOptions } from '@/lib/jobs/image-options'
import { readLocalWorkerCapabilities } from '@/lib/jobs/capabilities'

/** Validate the selected grouping scope and start its local pipeline workflow. */
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/batches/[id]/group'>
) {
  if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1')
    return json({ error: 'not_found' }, 404)
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
  if (
    !body ||
    !Number.isSafeInteger(body.batchRevision) ||
    !Array.isArray(body.plateIds) ||
    !body.plateIds.every((id) => typeof id === 'string')
  )
    return badRequest()
  const choice = chooseModel(body.model, 'desktop')
  if (!choice.ok) return badRequest()
  const options: ImageGroupOptions = { method: 'embeddings' }
  if (body.options !== undefined) {
    if (
      !body.options ||
      typeof body.options !== 'object' ||
      Array.isArray(body.options)
    )
      return badRequest()
    for (const [key, value] of Object.entries(body.options)) {
      if (key === 'method' && value === 'embeddings') continue
      if (
        !['colorSignal', 'backgroundMask', 'visionTiebreak'].includes(key) ||
        typeof value !== 'boolean'
      )
        return badRequest()
      options[key as 'colorSignal' | 'backgroundMask' | 'visionTiebreak'] =
        value
    }
  }
  const dependencies = jobsDeps()
  const capabilities = await readLocalWorkerCapabilities(dependencies)
  for (const key of [
    'group',
    'colorSignal',
    'backgroundMask',
    'visionTiebreak',
  ] as const) {
    if ((key === 'group' || options[key]) && !capabilities[key].available)
      return json(
        { error: 'unavailable', reason: capabilities[key].reason },
        422
      )
  }
  const id = await batchTarget((await ctx.params).id, auth.actor)
  const prepared = await prepareGroupScope(reviewDeps(), auth.actor, {
    batchId: id,
    batchRevision: Number(body.batchRevision),
    plateIds: body.plateIds,
  })
  if (!prepared.ok) return respond(prepared)
  const jobId = crypto.randomUUID()
  const created = await createJob(dependencies, {
    id: jobId,
    batchId: id,
    plateId: prepared.value.scope[0].plate.id,
    requestedBy: auth.actor.uid,
    stage: 'group',
    modelId: choice.model.id,
    groupScope: prepared.value.scope,
    stageOptions: options,
  })
  return created.ok
    ? json({ jobId, stage: 'group' }, 202)
    : json(
        { error: created.error },
        created.error === 'stale_input' ? 409 : 422
      )
}
