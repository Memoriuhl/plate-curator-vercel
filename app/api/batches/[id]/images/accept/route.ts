import { batchTarget } from '../../../../../../lib/server/draft-target'
import { acceptImage } from '@/lib/review/image'
import { currentActor, jobsDeps, reviewDeps } from '@/lib/server/context'
import { catalogChanged } from '@/lib/server/catalog-head'
import { badRequest, json, readJson, respond } from '@/lib/server/respond'

/**
 * Apply the chosen candidate image to the plate draft after validating the local job
 * reference.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/batches/[id]/images/accept'>
) {
  if (process.env.NEXT_PUBLIC_LOCAL_PIPELINE !== '1')
    return json({ error: 'not_found' }, 404)
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const body = await readJson(request)
  if (body?.previewOnly !== undefined && body.previewOnly !== false)
    return badRequest()
  if (
    !body ||
    !['jobId', 'candidateId', 'baseRevision'].every(
      (key) => typeof body[key] === 'string'
    )
  )
    return badRequest()
  const id = await batchTarget((await ctx.params).id, auth.actor)
  const saved = await acceptImage(reviewDeps(), jobsDeps(), auth.actor, {
    batchId: id,
    jobId: body.jobId as string,
    candidateId: body.candidateId as string,
    baseRevision: body.baseRevision as string,
  })
  if (saved.ok) catalogChanged()
  return respond(saved)
}
