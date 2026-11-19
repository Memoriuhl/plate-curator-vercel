import { cancelRun } from '../../../../../../lib/jobs/queue'
import { currentActor, jobsDeps } from '../../../../../../lib/server/context'
import {
  queueResponse,
  wakeAfterReply,
} from '../../../../../../lib/server/local-queue'

/**
 * Request cancellation of an eligible run and wake its workflow when the current job can
 * settle.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/local-pipeline/runs/[id]/cancel'>
) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const d = jobsDeps()
  const result = await cancelRun(d, auth.actor, (await ctx.params).id)
  if (result.ok) {
    const jobId = result.value.attempts.at(-1)?.jobIds.at(-1)
    const job = jobId ? await d.store.transaction((tx) => tx.get(jobId)) : null
    if (job) wakeAfterReply(job)
  }
  return queueResponse(result)
}
