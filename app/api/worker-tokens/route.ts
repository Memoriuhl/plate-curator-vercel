import { issueWorkerToken } from '../../../lib/jobs/tokens'
import { currentActor, jobsDeps } from '../../../lib/server/context'
import { badRequest, json, readJson } from '../../../lib/server/respond'

/** Validate the worker identifier and issue a scoped credential for an owner. */
export async function POST(request: Request) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const body = await readJson(request)
  const workerId = typeof body?.workerId === 'string' ? body.workerId.trim() : ''
  if (workerId.length === 0 || workerId.length > 64) return badRequest()

  const outcome = await issueWorkerToken(jobsDeps(), auth.actor, workerId)
  return outcome.ok ? json({ workerId, token: outcome.value.token, hash: outcome.value.hash }) : json({ error: outcome.error }, 403)
}
