import { chooseQueueImage } from '../../../../../../lib/jobs/queue-engine'
import { currentActor, jobsDeps } from '../../../../../../lib/server/context'
import { badRequest, readJson } from '../../../../../../lib/server/respond'
import {
  queueResponse,
  wakeLocalJob,
} from '../../../../../../lib/server/local-queue'

/** Save the curator's image candidate selection and wake the stage waiting for it. */
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/local-pipeline/runs/[id]/choice'>
) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const body = await readJson(request)
  if (typeof body?.jobId !== 'string' || typeof body.candidateId !== 'string')
    return badRequest()
  const d = jobsDeps()
  const result = await chooseQueueImage(
    d,
    auth.actor,
    (await ctx.params).id,
    body.jobId,
    body.candidateId
  )
  if (result.ok) {
    const job = await d.store.transaction((tx) => tx.get(body.jobId as string))
    if (job) await wakeLocalJob(job)
  }
  return queueResponse(result)
}
