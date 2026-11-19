import { draftWriteTarget } from '../../../../../../lib/server/draft-target'
import { parseStandardChange } from '../../../../../../lib/review/standard-change'
import { moveState } from '../../../../../../lib/review/move-state'
import { parseStateMoves } from '../../../../../../lib/review/state-move'
import { catalogChanged } from '../../../../../../lib/server/catalog-head'
import { currentActor, reviewDeps } from '../../../../../../lib/server/context'
import {
  badRequest,
  readJson,
  respond,
} from '../../../../../../lib/server/respond'

/** Place selected plates in the current state order. */
export async function PUT(
  request: Request,
  ctx: RouteContext<'/api/batches/[id]/state-order/[state]'>
) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const body = await readJson(request)
  const standard = parseStandardChange(body?.standard)
  const moves = parseStateMoves(body?.moves)
  if (!moves || standard === null || body?.order !== undefined)
    return badRequest()
  const { id, state } = await ctx.params
  const target = await draftWriteTarget(id, auth.actor)
  if (!target.ok) return target.response
  const outcome = await moveState(reviewDeps(), auth.actor, {
    batchId: target.id,
    state,
    moves,
    standard,
  })
  if (!outcome.ok) return respond(outcome)
  catalogChanged()
  return respond({ ok: true, value: outcome.value.batch })
}
