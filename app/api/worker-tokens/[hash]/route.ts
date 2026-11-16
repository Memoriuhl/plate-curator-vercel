import { revokeWorkerToken } from '../../../../lib/jobs/tokens'
import { currentActor, jobsDeps } from '../../../../lib/server/context'
import { json } from '../../../../lib/server/respond'

export async function DELETE(request: Request, ctx: RouteContext<'/api/worker-tokens/[hash]'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const { hash } = await ctx.params
  const outcome = await revokeWorkerToken(jobsDeps(), auth.actor, hash)
  return outcome.ok ? json({ revoked: hash }) : json({ error: outcome.error }, 403)
}
