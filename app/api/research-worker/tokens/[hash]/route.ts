import { currentActiveOwner } from '@/lib/server/context'
import { researchDeps } from '@/lib/server/research-context'
import { revokeResearchWorkerToken } from '@/lib/research/tokens'

export async function DELETE(request: Request, ctx: RouteContext<'/api/research-worker/tokens/[hash]'>) {
  const auth = await currentActiveOwner(request)
  if (!auth.ok) return auth.response
  const hash = (await ctx.params).hash
  if (!/^[a-f0-9]{64}$/.test(hash)) return Response.json({ error: 'bad_request' }, { status: 400 })
  await revokeResearchWorkerToken((await researchDeps()).store, hash)
  return new Response(null, { status: 204 })
}
