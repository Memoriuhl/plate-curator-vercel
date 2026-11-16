import { getJob } from '../../../../lib/jobs/jobs'
import { currentActor, jobsDeps } from '../../../../lib/server/context'
import { json } from '../../../../lib/server/respond'

export async function GET(request: Request, ctx: RouteContext<'/api/jobs/[id]'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const { id } = await ctx.params
  const job = await getJob(jobsDeps(), id)
  if (!job) return json({ error: 'not_found' }, 404)
  return json({ id: job.id, batchId: job.batchId, plateId: job.plateId, state: job.state, suggestions: job.result?.suggestions ?? [], model: job.result?.model ?? null })
}
