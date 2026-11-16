import { start } from 'workflow/api'
import { submitBatch } from '../../../../../lib/review/batch'
import { currentActor, reviewDeps } from '../../../../../lib/server/context'
import { badRequest, readJson, respond } from '../../../../../lib/server/respond'
import { approvalRun } from '../../../../../workflows/approval'

export async function POST(request: Request, ctx: RouteContext<'/api/batches/[id]/submit'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const body = await readJson(request)
  if (typeof body?.revision !== 'number') return badRequest()

  const { id } = await ctx.params
  const outcome = await submitBatch(reviewDeps(), auth.actor, id, body.revision)
  if (outcome.ok) await start(approvalRun, [id, outcome.value.revision])
  return respond(outcome)
}
