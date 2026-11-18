import { resumeHook, start } from 'workflow/api'
import { submitBatch } from '../../../../../lib/review/batch'
import { currentActor, reviewDeps } from '../../../../../lib/server/context'
import { badRequest, readJson, respond } from '../../../../../lib/server/respond'
import { approvalRun } from '../../../../../workflows/approval'

/**
 * Submit a batch and start its durable approval workflow when the transition succeeds.
 */
export async function POST(request: Request, ctx: RouteContext<'/api/batches/[id]/submit'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const body = await readJson(request)
  if (typeof body?.revision !== 'number') return badRequest()

  const { id } = await ctx.params
  const deps = reviewDeps()
  const outcome = await submitBatch(deps, auth.actor, id, body.revision)
  if (outcome.ok) {
    const revision = outcome.value.revision
    const run = await start(approvalRun, [id, revision], { experimental_hook: { token: `approval:${id}:${revision}` } })
    if (await deps.store.recordRun(id, revision, run.runId)) {
      outcome.value.approvalRun = { runId: run.runId, revision }
    } else {
      await resumeHook(`approval:${id}:${revision}`, { superseded: true })
    }
  }
  return respond(outcome)
}
