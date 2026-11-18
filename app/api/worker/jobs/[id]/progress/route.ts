import { reportJobPhase } from '@/lib/jobs/job-phase'
import { currentWorker, jobsDeps } from '@/lib/server/context'
import { badRequest, json, readJson } from '@/lib/server/respond'

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/worker/jobs/[id]/progress'>
) {
  const auth = await currentWorker(request)
  if (!auth.ok) return auth.response
  const body = await readJson(request)
  if (typeof body?.claimId !== 'string' || typeof body.index !== 'number')
    return badRequest()
  const { id } = await ctx.params
  const result = await reportJobPhase(
    jobsDeps(),
    auth.workerId,
    id,
    body.claimId,
    body.index
  )
  if (!result.ok)
    return json(
      { error: result.error },
      result.error === 'not_found'
        ? 404
        : result.error === 'forbidden'
          ? 403
          : result.error === 'invalid_result'
            ? 400
            : 409
    )
  return new Response(null, { status: 204 })
}
