import { retryRun } from '../../../../../../lib/jobs/queue'
import { currentActor, jobsDeps } from '../../../../../../lib/server/context'
import { badRequest, json, readJson } from '../../../../../../lib/server/respond'
import { queueResponse, startQueueWorkflow } from '../../../../../../lib/server/local-queue'

/** Validate a retry request and start the new attempt of its eligible queue run. */
export async function POST(request: Request, ctx: RouteContext<'/api/local-pipeline/runs/[id]/retry'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const body = await readJson(request)
  if (typeof body?.requestId !== 'string') return badRequest()
  const result = await retryRun(jobsDeps(), auth.actor, (await ctx.params).id, body.requestId)
  if (result.ok) {
    try { await startQueueWorkflow(result.value) } catch { return json({ error: 'start_failed', runId: result.value.id }, 503) }
  }
  return queueResponse(result, 202)
}
