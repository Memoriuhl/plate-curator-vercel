import { currentActor } from '@/lib/server/context'
import { researchDeps, researchResponse } from '@/lib/server/research-context'
import { getResearch } from '@/lib/research/jobs'

export async function GET(request: Request, ctx: RouteContext<'/api/research/[id]'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  return researchResponse(await getResearch(await researchDeps(), auth.actor, (await ctx.params).id))
}
