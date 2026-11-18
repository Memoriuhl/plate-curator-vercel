import {
  researchDeps,
  readResearchJson,
  researchResponse,
} from '@/lib/server/research-context'
import { researchWorkerIdentity } from '@/lib/research/tokens'
import { renewResearchClaim } from '@/lib/research/jobs'

/** Renew the worker's current research claim before the lease expires. */
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/research-worker/jobs/[id]/heartbeat'>
) {
  const deps = await researchDeps()
  const worker = await researchWorkerIdentity(deps.store, request)
  if (!worker)
    return Response.json({ error: 'unauthenticated' }, { status: 401 })
  const body = await readResearchJson(request)
  if (typeof body?.claimId !== 'string')
    return Response.json({ error: 'bad_request' }, { status: 400 })
  return researchResponse(
    await renewResearchClaim(deps, worker, {
      jobId: (await ctx.params).id,
      claimId: body.claimId,
    })
  )
}
