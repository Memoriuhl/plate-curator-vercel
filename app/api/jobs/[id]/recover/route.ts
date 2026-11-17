import { resumeHook } from 'workflow/api'
import { recoverLocalOrphanJob } from '../../../../../lib/jobs/queue-failure'
import { currentActor, jobsDeps } from '../../../../../lib/server/context'
import { badRequest, json, readJson } from '../../../../../lib/server/respond'

export async function POST(request: Request, ctx: RouteContext<'/api/jobs/[id]/recover'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const body = await readJson(request)
  if (body?.workerStopped !== true || typeof body.claimId !== 'string') return badRequest()
  const result = await recoverLocalOrphanJob(jobsDeps(), auth.actor, (await ctx.params).id, body.claimId)
  if (!result.ok) return json({ error: result.error }, result.error === 'forbidden' ? 403 : result.error === 'not_found' ? 404 : 409)
  await resumeHook(`${result.value.stage ? 'pipeline' : 'tagging'}:${result.value.id}`, { jobId: result.value.id }).catch(() => undefined)
  return json({ job: result.value })
}
