import { confirmStoppedWorker } from '../../../../../../lib/jobs/queue-engine'
import { currentActor, jobsDeps } from '../../../../../../lib/server/context'
import { badRequest, readJson } from '../../../../../../lib/server/respond'
import { queueResponse, wakeLocalJob } from '../../../../../../lib/server/local-queue'

/** Confirm that the abandoned worker claim has stopped so the run can recover. */
export async function POST(request: Request, ctx: RouteContext<'/api/local-pipeline/runs/[id]/recover'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const body = await readJson(request)
  if (body?.workerStopped !== true || typeof body.jobId !== 'string' || typeof body.claimId !== 'string') return badRequest()
  const d = jobsDeps()
  const result = await confirmStoppedWorker(d, auth.actor, (await ctx.params).id, body.jobId, body.claimId)
  if (result.ok) { const job = await d.store.transaction(tx => tx.get(body.jobId as string)); if (job) await wakeLocalJob(job) }
  return queueResponse(result)
}
