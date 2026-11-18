import { failLocalJob } from '../../../../../../lib/jobs/queue-failure'
import { currentWorker, jobsDeps } from '../../../../../../lib/server/context'
import {
  badRequest,
  json,
  readJson,
} from '../../../../../../lib/server/respond'
import { wakeLocalJob } from '../../../../../../lib/server/local-queue'

/** Record a worker failure under its current claim and notify the queue workflow. */
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/worker/jobs/[id]/fail'>
) {
  const worker = await currentWorker(request)
  if (!worker.ok) return worker.response
  const body = await readJson(request)
  if (typeof body?.claimId !== 'string' || typeof body.error !== 'string')
    return badRequest()
  const result = await failLocalJob(
    jobsDeps(),
    worker.workerId,
    (await ctx.params).id,
    body.claimId,
    body.error
  )
  if (!result.ok)
    return json(
      { error: result.error },
      result.error === 'forbidden'
        ? 403
        : result.error === 'not_found'
          ? 404
          : 409
    )
  await wakeLocalJob(result.value)
  return json({ state: result.value.state })
}
