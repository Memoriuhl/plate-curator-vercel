import { resumeHook } from 'workflow/api'
import { reportResult } from '../../../../../../lib/jobs/jobs'
import type { ReportInput } from '../../../../../../lib/jobs/types'
import { currentWorker, jobsDeps } from '../../../../../../lib/server/context'
import {
  badRequest,
  json,
  readJson,
} from '../../../../../../lib/server/respond'
import { wakeAfterReply } from '../../../../../../lib/server/local-queue'

const statusFor = {
  not_found: 404,
  invalid_result: 400,
  forbidden: 403,
  already_exists: 409,
  claim_expired: 409,
  claim_mismatch: 409,
  stale_input: 409,
  result_mismatch: 409,
} as const

/**
 * Validate and settle an authenticated worker report and wake the workflow waiting for
 * it.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/worker/jobs/[id]/report'>
) {
  const worker = await currentWorker(request)
  if (!worker.ok) return worker.response

  const body = await readJson(request)
  if (typeof body?.claimId !== 'string') return badRequest()

  const { id } = await ctx.params
  const outcome = await reportResult(
    jobsDeps(),
    worker.workerId,
    id,
    body.claimId,
    body as unknown as ReportInput
  )
  if (!outcome.ok)
    return json({ error: outcome.error }, statusFor[outcome.error])

  if (outcome.value.queueRunId) wakeAfterReply(outcome.value)
  else
    await resumeHook(`${outcome.value.stage ? 'pipeline' : 'tagging'}:${id}`, {
      jobId: id,
    }).catch(() => undefined)
  return json({ state: outcome.value.state })
}
