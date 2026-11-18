import { researchDeps, readResearchJson, researchResponse } from '@/lib/server/research-context'
import { researchWorkerIdentity } from '@/lib/research/tokens'
import { reportResearch } from '@/lib/research/jobs'

/** Validate and settle a research worker report against its current claim. */
export async function POST(request: Request, ctx: RouteContext<'/api/research-worker/jobs/[id]/report'>) {
  const deps = await researchDeps()
  const worker = await researchWorkerIdentity(deps.store, request)
  if (!worker) return Response.json({ error: 'unauthenticated' }, { status: 401 })
  const body = await readResearchJson(request)
  if (typeof body?.claimId !== 'string' || !body.result) return Response.json({ error: 'bad_request' }, { status: 400 })
  return researchResponse(await reportResearch(deps, worker, { jobId: (await ctx.params).id, claimId: body.claimId, result: body.result }))
}
