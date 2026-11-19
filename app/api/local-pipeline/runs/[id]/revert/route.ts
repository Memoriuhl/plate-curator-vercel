import { readRunRevertTarget, revertQueueRun } from '@/lib/jobs/revert-run'
import { sharedDraftId } from '@/lib/review/draft-id'
import { batchTarget } from '@/lib/server/draft-target'
import { catalogChanged } from '@/lib/server/catalog-head'
import {
  currentActor,
  jobsDeps,
  reviewDeps,
  reviewEnv,
} from '@/lib/server/context'
import { badRequest, readJson, respond } from '@/lib/server/respond'

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/local-pipeline/runs/[id]/revert'>
) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const { id } = await ctx.params
  const batchId = sharedDraftId(reviewEnv())
  return respond(await readRunRevertTarget(jobsDeps(), batchId, id))
}

/** Restore the eligible unpublished fields from a completed pipeline run. */
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/local-pipeline/runs/[id]/revert'>
) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const { id } = await ctx.params
  const body = await readJson(request)
  const attempt = body?.attempt
  const jobIds = body?.jobIds
  if (
    typeof attempt !== 'number' ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !Array.isArray(jobIds) ||
    !jobIds.every((id) => typeof id === 'string')
  )
    return badRequest()
  const batchId = await batchTarget('draft', auth.actor)
  const outcome = await revertQueueRun(
    jobsDeps(),
    reviewDeps(),
    auth.actor,
    batchId,
    id,
    { attempt, jobIds }
  )
  if (outcome.ok && outcome.value.reverted) catalogChanged()
  return respond(outcome)
}
