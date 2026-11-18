import { getJobForActor } from '../../../../lib/jobs/jobs'
import { currentActor, jobsDeps } from '../../../../lib/server/context'
import { json, respond } from '../../../../lib/server/respond'

/** Return the actor's job status and any available stage result. */
export async function GET(request: Request, ctx: RouteContext<'/api/jobs/[id]'>) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response

  const { id } = await ctx.params
  const deps = jobsDeps()
  const scoped = await getJobForActor(deps, auth.actor, id)
  const outcome = !scoped.ok && scoped.error === 'not_found' && deps.localScope
    ? await getJobForActor(jobsDeps({ unscoped: true }), auth.actor, id) : scoped
  if (!outcome.ok) return respond(outcome)
  const job = outcome.value
  return json({ id: job.id, batchId: job.batchId, plateId: job.plateId, requestedBy: job.requestedBy, state: job.state, inputHash: job.inputHash, suggestions: job.result?.suggestions ?? [], model: job.result?.model ?? null, modelId: job.modelId ?? null,
    ...(process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' && job.localScope ? { previewOnly: job.previewOnly === true } : {}),
    ...(process.env.NEXT_PUBLIC_LOCAL_PIPELINE === '1' && job.stage ? { stage: job.stage, fieldSuggestion: job.result?.fieldSuggestion ?? null, stageError: job.result?.stageError ?? null } : {}),
  })
}
