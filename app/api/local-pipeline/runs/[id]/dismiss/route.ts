import { dismissRun } from '@/lib/jobs/queue'
import { currentActor, jobsDeps } from '@/lib/server/context'
import { queueResponse } from '@/lib/server/local-queue'

export async function POST(
  request: Request,
  ctx: RouteContext<'/api/local-pipeline/runs/[id]/dismiss'>
) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  return queueResponse(
    await dismissRun(jobsDeps(), auth.actor, (await ctx.params).id)
  )
}
