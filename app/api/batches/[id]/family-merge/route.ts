import { draftWriteTarget } from '../../../../../lib/server/draft-target'
import { moveState } from '@/lib/review/move-state'
import { isStateMoveId, parseStateMoves } from '@/lib/review/state-move'
import { parseStandardChange } from '@/lib/review/standard-change'
import { currentActor, reviewDeps } from '@/lib/server/context'
import { badRequest, readJson, respond } from '@/lib/server/respond'

/** Join the selected plates to the current destination family. */
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/batches/[id]/family-merge'>
) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const body = await readJson(request)
  const standard = parseStandardChange(body?.standard)
  const destinationId = body?.destinationId
  if (
    typeof destinationId !== 'string' ||
    !isStateMoveId(body?.operationId) ||
    standard === null
  )
    return badRequest()
  const moves = parseStateMoves([
    {
      plateIds: body?.plateIds,
      placement: { kind: 'join', anchorId: destinationId },
    },
  ])
  if (!moves) return badRequest()
  const target = await draftWriteTarget((await ctx.params).id, auth.actor)
  if (!target.ok) return target.response
  const outcome = await moveState(reviewDeps(), auth.actor, {
    batchId: target.id,
    operationId: body.operationId,
    state: destinationId.split('.')[0],
    moves,
    standard,
    keepStandardOnJoin: !standard,
  })
  if (!outcome.ok) return respond(outcome)
  return respond({
    ok: true,
    value: { ...outcome.value.merge!, revision: outcome.value.revision },
  })
}
