import { currentActor } from '@/lib/server/context'
import { readResearchJson, researchDeps, researchResponse } from '@/lib/server/research-context'
import { acceptResearch } from '@/lib/research/accept'

export async function POST(request: Request, ctx: RouteContext<'/api/research/[id]/accept'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const body = await readResearchJson(request)
  if (!body || typeof body.baseRevision !== 'string' || !Array.isArray(body.fields) || !body.fields.every(field => typeof field === 'string')) return Response.json({ ok: false, error: 'invalid_result' }, { status: 400 })
  return researchResponse(await acceptResearch(await researchDeps(), auth.actor, { jobId: (await ctx.params).id, baseRevision: body.baseRevision, fields: body.fields, ...(body.draft !== undefined ? { draft: body.draft } : {}) }))
}
