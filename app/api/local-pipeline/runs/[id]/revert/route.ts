import { revertQueueRun } from '@/lib/jobs/revert-run'
import { batchTarget } from '@/lib/server/draft-target'
import { catalogChanged } from '@/lib/server/catalog-head'
import { currentActor, jobsDeps, reviewDeps } from '@/lib/server/context'
import { respond } from '@/lib/server/respond'

/** Restore the eligible unpublished fields from a completed pipeline run. */
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/local-pipeline/runs/[id]/revert'>
) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const { id } = await ctx.params
  const batchId = await batchTarget('draft', auth.actor)
  const outcome = await revertQueueRun(
    jobsDeps(),
    reviewDeps(),
    auth.actor,
    batchId,
    id
  )
  if (outcome.ok && outcome.value.reverted) catalogChanged()
  return respond(outcome)
}
