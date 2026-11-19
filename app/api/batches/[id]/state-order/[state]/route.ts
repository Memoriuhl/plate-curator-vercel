import { draftWriteTarget } from '../../../../../../lib/server/draft-target'
import { parseStandardChange } from '../../../../../../lib/review/standard-change'
import { reorderState } from '../../../../../../lib/review/batch'
import {
  limits,
  parseEditableFields,
} from '../../../../../../lib/review/fields'
import { catalogChanged } from '../../../../../../lib/server/catalog-head'
import { currentActor, reviewDeps } from '../../../../../../lib/server/context'
import {
  badRequest,
  readJson,
  respond,
} from '../../../../../../lib/server/respond'

/**
 * Validate and save a new state order, including a coordinated standard-plate change
 * when supplied.
 */
export async function PUT(
  request: Request,
  ctx: RouteContext<'/api/batches/[id]/state-order/[state]'>
) {
  const auth = await currentActor(request)
  if (!auth.ok) return auth.response
  const body = await readJson(request)
  const standard = parseStandardChange(body?.standard)
  if (standard === null) return badRequest()
  if (
    typeof body?.batchRevision !== 'number' ||
    !Number.isSafeInteger(body.batchRevision) ||
    body.batchRevision < 0 ||
    !Array.isArray(body.order) ||
    !body.order.every((id: unknown) => typeof id === 'string')
  )
    return badRequest()
  const params = await ctx.params
  const state = params.state
  const target = await draftWriteTarget(params.id, auth.actor)
  if (!target.ok) return target.response
  const id = target.id
  const values =
    body.promotions ?? (body.promotion !== undefined ? [body.promotion] : [])
  if (
    !Array.isArray(values) ||
    values.length > limits.plates ||
    (body.promotions !== undefined && body.promotion !== undefined)
  )
    return badRequest()
  const promotions: { plateId: string; templateFamily: string }[] = []
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return badRequest()
    const fields = parseEditableFields({ templateFamily: value.templateFamily })
    if (
      typeof value.plateId !== 'string' ||
      !value.plateId ||
      !fields?.templateFamily
    )
      return badRequest()
    promotions.push({
      plateId: value.plateId,
      templateFamily: fields.templateFamily,
    })
  }
  const outcome = await reorderState(reviewDeps(), auth.actor, {
    batchId: id,
    state,
    batchRevision: body.batchRevision,
    order: body.order,
    promotions,
    standard,
  })
  if (outcome.ok) catalogChanged()
  return respond(outcome)
}
